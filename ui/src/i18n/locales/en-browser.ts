import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Browser consumers register their fallback without taxing UI startup.
const enBrowser = {
  browser: {
    nativeTab: "App tab",
    remoteTab: "Agent browser tab",
    stop: "Stop loading",
    profile: "Browser profile: {profile}",
    title: "Browser",
    open: "Open",
    openPanel: "Open browser panel",
    moreActions: "More actions",
    copyUrl: "Copy URL",
    copySelection: "Copy selection",
    copySelectionChecking: "Checking for selected text…",
    copySelectionEmpty: "Ask the agent to select text in the page first.",
    copySelectionNoPage: "Open a page to copy its text.",
    copySelectionNative: "Select text in the Mac tab and press ⌘C.",
    copyNothingSelected:
      "Nothing is selected in the page. Ask the agent to select text, then copy again.",
    copyDisconnected: "Couldn’t copy. Reconnect to the browser and try again.",
    copyUnavailable:
      "Copying page text is disabled (browser.evaluateEnabled=false). Enable it to copy from this panel.",
    copyReadFailed: "Couldn’t read the page selection. Check the browser connection and try again.",
    copyWriteFailed: "Couldn’t write to your clipboard. Allow clipboard access and try again.",
    copyTruncated:
      "Copied. The selection was too long, so only the first {count} characters were copied.",
    openNewTab: "Open in new tab",
    openWithinOpenClaw: "Open in OpenClaw",
    toggle: "Toggle browser panel",
    close: "Close browser panel",
    resize: "Resize browser panel",
    newTab: "New tab",
    closeTab: "Close tab",
    untitledTab: "New tab",
    tweetPost: "Post on X",
    back: "Back",
    forward: "Forward",
    reload: "Reload",
    openExternal: "Open in your browser",
    urlPlaceholder: "Enter a URL and press Enter",
    dockBottom: "Dock to bottom",
    dockRight: "Dock to right",
    annotate: "Annotate page",
    inspect: "Inspect element",
    annotateSend: "Send to chat",
    annotateUndo: "Undo",
    annotateClear: "Clear",
    annotateDone: "Exit annotate mode",
    annotateHint: "Draw on the page, then send the markup to your chat.",
    inspectName: "Name",
    inspectRole: "Role",
    inspectFocusable: "Focusable",
    loading: "Loading page…",
    notRunning: "The gateway browser is not running.",
    start: "Start browser",
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
    annotatePrompt: {
      browserTarget: "Browser target: {target}",
      // introTitled/elementDetail (not intro/element): translated keys never
      // retranslate on source-wording changes, so the provenance-label rewrite
      // required fresh key names to propagate to all locales.
      introTitled:
        'I annotated the page at {url} (page-reported title: "{title}") — the attached screenshot shows my markup.',
      introUntitled: "I annotated the page at {url} — the attached screenshot shows my markup.",
      region:
        "Marked region {index}: centered around {x}% across / {y}% down, spanning about {width}% × {height}% of the view.",
      moreRegions: "…plus {count} more marked region(s), all visible in the screenshot.",
      elementDetail:
        "Marked element (page-reported): {descriptor} — {width}×{height}px at ({x}, {y}).",
      outro: "Please look at the marked area and tell me what you make of it.",
    },
    address: "Page address",
    go: "Go",
    actions: "Browser actions",
    navigation: "Browser navigation",
    loadFailed: "Couldn’t load browser",
    newBrowserTab: "New browser tab",
    unavailable:
      "Browser control is unavailable for this connection. Reconnect with browser access.",
    navigationBlocked:
      "The current browser navigation rules block this address. Select another tab or enter an allowed address.",
    navigationCheckFailed: "OpenClaw couldn’t verify this tab’s address. Refresh to try again.",
    tabUnavailable: "This tab is no longer available. Select another tab.",
    noChatTarget: "Open a chat session first so the annotation has somewhere to go.",
    annotationLimitReached:
      "Remove a browser annotation before retrying (maximum 4 cards and 8,000 characters of generated context).",
    inspectUnavailable: "Element inspection is disabled (browser.evaluateEnabled=false).",
    annotationSent: "Annotation added to the chat composer.",
    dashboardSessionShared: "You and your agent share this isolated session browser",
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
    manualTextCorrection: "Autocorrect is unavailable in browser control. Edit the text directly.",
  },
} satisfies TranslationMap;

export const registerBrowserEnglish = Object.assign(
  () => {
    const { errors, annotatePrompt, ...labels } = enBrowser.browser;
    // Extend the shared objects so existing Browser copy and readers survive.
    Object.assign(en.browser, labels);
    Object.assign(en.browser.errors, errors);
    Object.assign(en.browser.annotatePrompt, annotatePrompt);
  },
  { catalog: enBrowser },
);
