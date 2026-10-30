import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Terminal controls register with the lazy terminal; shared launch labels stay eager.
const enTerminal = {
  terminal: {
    title: en.terminal.title,
    availableSessions: "Available sessions",
    inputLabel: "Terminal input",
    sendInput: "Send terminal input",
    closeSessionMessage: "Close this terminal session? Its running process will end.",
    sessionsLabel: "Sessions",
    addFilesLabel: "Add files",
    copiedToClipboard: "Copied to clipboard",
    toggle: en.terminal.toggle,
    open: en.terminal.open,
    openWindow: "Open terminal in new window",
    hide: "Hide terminal",
    resize: "Resize terminal panel",
    newSession: "New terminal session",
    addFiles: "Add files to terminal",
    dropFiles: "Drop files to add them",
    uploadProgress: "Uploading {current} of {total}",
    uploadFailed: "Upload failed",
    retryUpload: "Retry",
    insertUploadedPaths: "Insert uploaded paths",
    uploadExpired: "Uploaded files may have expired. Cancel this batch and choose the files again.",
    closeSession: "Close terminal session",
    sessions: "Terminal sessions",
    refreshSessions: "Refresh",
    loadingSessions: "Loading sessions…",
    noSessions: "No live terminal sessions",
    currentSession: "current",
    sessionAttached: "attached",
    attachSession: "Attach session",
    attachFailed: "Could not attach terminal session",
    deliveryFailed: "Terminal delivery could not be confirmed. Reconnect before trying again.",
    inputPaused: "Terminal input is paused until the Gateway reconnects.",
    startCancelled: en.terminal.startCancelled,
    connecting: "Connecting to session…",
    connectionTimedOut: "Session did not connect within 30 seconds.",
    refreshRequired: "Control UI updated. Reload this page to continue the terminal action.",
    tabLabel: "shell {n}",
    tabHint: "{agent} · {cwd}",
    agentOwnedBadge: "agent",
    exited: "exited",
    exitedCode: "exited ({code})",
    exitedSignal: "exited (signal {signal})",
    detached: "detached",
    dockBottom: "Dock to bottom",
    dockRight: "Dock to right",
    dockMain: "Fill main content area",
    dockMode: "Terminal panel position",
    unavailable: en.terminal.unavailable,
    unusableSession:
      "The Gateway returned an unusable terminal session (missing {field}). The Gateway is likely older than this Control UI — update it, then retry.",
    uploadTooLarge: "File exceeds the 16 MiB terminal upload limit: {file}",
    uploadUnsafeCmdPath: "Cannot safely insert an uploaded path containing % or ! into cmd.exe",
    uploadUnsupportedShell: "Cannot safely insert an uploaded path into unsupported shell: {shell}",
    uploadInvalidNativePath: "Cannot safely insert the uploaded native file path",
  },
} satisfies TranslationMap;

export const registerTerminalEnglish = Object.assign(
  () => {
    Object.assign(en.terminal, enTerminal.terminal);
  },
  { catalog: enTerminal },
);
