import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Browser consumers register their fallback without taxing UI startup.
const enBrowser = {
  browser: {
    dashboardShared: "You and your agent share this browser page",
    dashboardStopped: "This dashboard's browser is stopped.",
    dashboardStopping: "Browser stop is pending. Retry to finish closing its tab.",
    dashboardStop: "Stop browser",
    dashboardRetryStop: "Retry stop",
    dashboardResume: "Resume browser",
    dashboardReconnect: "Reconnect",
    dashboardUnavailable: "Connect to a Gateway with browser access to use this dashboard.",
    dashboardMissingIdentity: "Save this dashboard widget again before opening its browser.",
    dashboardInvalidReply:
      "The browser response does not match this dashboard. Reconnect and try again.",
    downloading: "Downloading…",
    downloadFile: "Download file",
    inputLabel: "Browser input: click a field in the page, then type or paste",
    errors: {
      pasteFailed: "Could not paste. Reconnect to a managed browser and try again.",
      requestFailed: "Browser request failed: {error}",
      downloadFailed:
        "Could not download this file: {error}. Try again, or open it in your browser to save it.",
      downloadEmpty: "No file returned.",
      screenshotPathMissing: "Browser screenshot did not return a media path.",
      screenshotFetchTimedOut: "Screenshot fetch timed out.",
      screenshotFetchFailed: "Screenshot fetch failed ({status}).",
      screenshotReadFailed: "Screenshot read failed.",
      screenshotDecodeFailed: "Screenshot decode failed.",
      canvasUnavailable: "Canvas 2D context unavailable.",
    },
  },
} satisfies TranslationMap;

export const registerBrowserEnglish = Object.assign(
  () => {
    const { errors, ...labels } = enBrowser.browser;
    // Extend both shared objects so existing Browser copy and readers survive.
    Object.assign(en.browser, labels);
    Object.assign(en.browser.errors, errors);
  },
  { catalog: enBrowser },
);
