import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Browser consumers register their fallback without taxing UI startup.
const enBrowser = {
  browser: {
    downloading: "Downloading…",
    downloadFile: "Download file",
    errors: {
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
