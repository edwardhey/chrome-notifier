// Simple script to poll PagerDuty API for new incidents, and trigger a Chrome notification for
// any it finds. Will also give user ability to ack/resolve incidents right from the notifs.

// Helper wrappers for HTTP methods.
function HTTP(apiKey)
{
    // Members
    var self       = this;   // Self-reference
    self.apiKey    = apiKey; // API key used for requests.
    self.userAgent = "pd-chrome-notifier-" + chrome.app.getDetails().version; // Will be in the X-Requested-With header of requests.

    // Wrapper for generic XMLHttpRequest stuff
    this.prepareRequest = function prepareRequest(method, url)
    {
        var xhr = new XMLHttpRequest();
        xhr.open(method, url, true);
        xhr.setRequestHeader("X-Requested-With", self.userAgent);
        xhr.setRequestHeader("X-PagerDuty-Api-Local", 1);
        xhr.setRequestHeader("Accept", "application/vnd.pagerduty+json;version=2");

        // If we have a valid API key, authenticate using that.
        if (self.apiKey != null && self.apiKey.length == 20)
        {
            xhr.setRequestHeader("Authorization", "Token token=" + self.apiKey);
        }

        return xhr;
    }

    // Perform a GET request, and trigger the callback with the result.
    this.GET = function GET(url, callback)
    {
        var req = self.prepareRequest("GET", url);
        req.onreadystatechange = function()
        {
            if (req.readyState == 4)
            {
                try
                {
                    callback(JSON.parse(req.responseText));
                }
                catch(e)
                {
                    // Ignore any parsing errors and carry on.
                }
            }
        };
        req.send();
    }

    // Fire and forget a PUT request.
    this.PUT = function PUT(url, data)
    {
        var req = self.prepareRequest("PUT", url);
        req.setRequestHeader("Content-Type", "application/json");
        req.send(data);
    }
}

// Will poll continually at the pollInterval until it's destroyed (_destruct() is called).
function PagerDutyNotifier()
{
    // Members
    var self                = this;  // Self-reference
    self.account            = null;  // The PagerDuty account subdomain to check.
    self.apiKey             = null;  // Optional API key to not require active session.
    self.pollInterval       = 15;    // Number of seconds between checking for new notifications.
    self.includeLowUgency   = false; // Whether to include low urgency incidents.
    self.removeButtons      = false; // Whether or not to unclude the action buttons.
    self.openOnAck          = false; // Whether to open the incident in a new tab when ack-ing.
    self.notifSound         = false; // Whether to play a notification sound.
    self.requireInteraction = false; // Whether the notification will require user interaction to dismiss.
    self.filterServices     = null;  // ServiceID's of services to only show alerts for.
    self.filterUsers        = null;  // UserID's of users to only show alerts for.
    self.http               = null;  // Helper for HTTP calls.
    self.poller             = null;  // This points to the interval function so we can clear it if needed.
    self.showBadgeUpdates   = false; // Whether we show updates on the toolbar badge.

    // Ctor
    self._construct = function _construct()
    {
        // Load in configuration, and then set up everything we need.
        self.loadConfiguration(function()
        {
            // If no account set up (first install), then do nothing. User will need to add
            // config. Once they save, a reload will be triggered and things will kick off.
            if (self.account == null || self.account == '') { return; }

            self.http = new HTTP(self.apiKey);
            self.setupPoller();
        });
    }

    // Dtor
    self._destruct = function _destruct()
    {
        clearInterval(self.poller);
        self = null;
    }

    // This loads any configuration we have stored with chrome.storage
    self.loadConfiguration = function loadConfiguration(callback)
    {
        chrome.storage.sync.get(
        {
            pdAccountSubdomain: '',
            pdAPIKey: null,
            pdIncludeLowUrgency: false,
            pdRemoveButtons: false,
            pdOpenOnAck: false,
            pdNotifSound: false,
            pdRequireInteraction: false,
            pdFilterServices: null,
            pdFilterUsers: null,
            pdShowBadgeUpdates: false
        },
        function(items)
        {
            self.account            = items.pdAccountSubdomain;
            self.apiKey             = items.pdAPIKey;
            self.includeLowUgency   = items.pdIncludeLowUrgency;
            self.removeButtons      = items.pdRemoveButtons;
            self.openOnAck          = items.pdOpenOnAck;
            self.notifSound         = items.pdNotifSound;
            self.requireInteraction = items.pdRequireInteraction;
            self.filterServices     = items.pdFilterServices;
            self.filterUsers        = items.pdFilterUsers;
            self.showBadgeUpdates   = items.pdShowBadgeUpdates;
            callback(true);
        });
    }

    // This will set up the poller process.
    self.setupPoller = function setupPoller()
    {
        self.poller = setInterval(function() { self.polled(); }, self.pollInterval * 1000);
        self.polled();
    }

    // This is the method that's executed on each poll.
    self.polled = function polled()
    {
      self.pollNewIncidents();
      self.updateToolbarBadge();
    }

    // This will handle the event triggered from clicking one of the notification's buttons.
    self.handlerButtonClicked = function handlerButtonClicked(notificationId, buttonIndex)
    {
        switch (buttonIndex)
        {
            case 0: // Acknowledge
                self.http.PUT(
                  'https://' + self.account + '.pagerduty.com/api/v1/incidents/' + notificationId,
                  '{"incident":{"type":"incident_reference","status":"acknowledged"}}'
                );
                if (self.openOnAck) { self.handlerNotificationClicked(notificationId); }
                break;

            case 1: // Resolve
                self.http.PUT(
                  'https://' + self.account + '.pagerduty.com/api/v1/incidents/' + notificationId,
                  '{"incident":{"type":"incident_reference","status":"resolved"}}'
                );
                break;
        }
        setTimeout(function() { self.updateToolbarBadge(); }, 200); // Force a badge update, so it changes quickly.
    }

    // This will handle the event triggered when clicking on the main notification area.
    self.handlerNotificationClicked = function handlerNotificationClicked(notificationId)
    {
        window.open('https://' + self.account + '.pagerduty.com/incidents/' + notificationId);
    }

    // This is the poller action, which will trigger an API request and then pass any incidents
    // it gets to the parsing function.
    self.pollNewIncidents = function pollNewIncidents()
    {
        // Sanity check that an account has been set.
        if (self.account == '') { return; }

        // We only want events triggered since we last polled.
        var since = new Date();
        since.setSeconds(since.getSeconds() - self.pollInterval);

        // Construct the URL
        var url = 'https://' + self.account + '.pagerduty.com/api/v1/incidents?'
                + 'statuses[]=triggered&'
                + 'since=' + since.toISOString() + '&'
                + 'limit=5&'; // More than this would be silly to show notifications for.
        url = self.includeFilters(url);

        // Make the request.
        self.http.GET(url, self.parseIncidents);
    }

    // Adds filters to a URL we'll be using in a request
    self.includeFilters = function includeFilters(url)
    {
        // Limit to high urgency if that's all the user wants.
        if (!self.includeLowUgency) { url = url + 'urgencies[]=high&'; }

        // Add a service filter if we have one.
        if (self.filterServices && self.filterServices != null && self.filterServices != "")
        {
            url = url + 'service_ids[]=' + self.filterServices + '&';
        }

        // Add a user filter if we have one.
        if (self.filterUsers && self.filterUsers != null && self.filterUsers != "")
        {
            url = url + 'user_ids[]=' + self.filterUsers + '&';
        }

        return url;
    }

    // This will parse the AJAX response and trigger notifications for each incident.
    self.parseIncidents = function parseIncidents(data)
    {
        for (var i in data.incidents) { self.triggerNotification(data.incidents[i]); }
    }

    // This will update the icon badge in the toolbar.
    self.updateToolbarBadge = function updateToolbarBadge()
    {
        if (!self.showBadgeUpdates)
        {
            chrome.browserAction.setBadgeText({ text: '' });
            return;
        }

        // Check for any triggered incidents at all that follow our filters.
        var url = self.includeFilters('https://' + self.account + '.pagerduty.com/api/v1/incidents?statuses[]=triggered&')
        self.http.GET(url, function(data)
        {
          if (data.incidents.length == 0)
          {
              chrome.browserAction.setBadgeText({ text: '' });
              return;
          }

          chrome.browserAction.setBadgeText({ text: '' + data.incidents.length });
          chrome.browserAction.setBadgeBackgroundColor({ color: [166, 0, 0, 255] });
        });
    }

    // This will trigger the actual notification based on an incident object.
    self.triggerNotification = function triggerNotification(incident)
    {
        // Define the buttons to show in the notification. Will be empty if user asked to remove.
        var buttons = self.removeButtons ? [] : [
            {
                title: "Acknowledge",
                iconUrl: chrome.extension.getURL("images/icon-acknowledge.png")
            },
            {
                title: "Resolve",
                iconUrl: chrome.extension.getURL("images/icon-resolve.png")
            }
        ];

        chrome.notifications.create(incident.id,
        {
            type: "basic",
            iconUrl: chrome.extension.getURL("images/icon-256.png"),
            title: incident.summary,
            message: "Service: " + incident.service.summary,
            contextMessage: incident.urgency.charAt(0).toUpperCase() + incident.urgency.slice(1) + " Urgency",
            priority: 2,
            isClickable: true,
            buttons: buttons,
            requireInteraction: self.requireInteraction
        });

        // Trigger notification sound if user wants it.
        if (self.notifSound)
        {
            var notifSound = new Audio("audio/notification.mp3");
            notifSound.play();
        }
    }

    self._construct();
}

// Add event handlers for button/notification clicks, and delegate to the currently active notifier object.
chrome.notifications.onButtonClicked.addListener(function(notificationId, buttonIndex)
{
    var bgpg = chrome.extension.getBackgroundPage();
    bgpg.getNotifier().handlerButtonClicked(notificationId, buttonIndex);
    chrome.notifications.clear(notificationId);
});
chrome.notifications.onClicked.addListener(function(notificationId)
{
    var bgpg = chrome.extension.getBackgroundPage();
    bgpg.getNotifier().handlerNotificationClicked(notificationId);
    chrome.notifications.clear(notificationId);
});

// Add event handler for the toolbar icon click.
chrome.browserAction.onClicked.addListener(function(tab)
{
    chrome.tabs.create({ 'url': 'https://' + chrome.extension.getBackgroundPage().getNotifier().account + '.pagerduty.com/incidents?status=triggered' })
});

// If this is the first installation, show the options page so user can set up their settings.
chrome.runtime.onInstalled.addListener(function(details)
{
    if (details.reason == 'install')
    {
        chrome.tabs.create({ 'url': 'chrome://extensions/?options=' + chrome.runtime.id });
    }
});

// The currently active notifier object, and accessor.
var _pdNotifier = null;
function getNotifier() { return _pdNotifier; }

// This will reload/trigger the the notifier (and pick up any new configuration options).
function reloadNotifier()
{
    if (_pdNotifier != null) { _pdNotifier._destruct(); }
    _pdNotifier = new PagerDutyNotifier();
}

// Listen for Chrome Alarms and retrigger the notifier when one is caught.
chrome.alarms.onAlarm.addListener(function(alarm) { reloadNotifier(); });

// Sets up a Chrome Alarm to retrigger the notifier every so often, to make sure it's always running.
chrome.alarms.create("pagerduty-notifier", { periodInMinutes: 1 });

// Initial run, as alarm won't trigger immediately.
reloadNotifier();
