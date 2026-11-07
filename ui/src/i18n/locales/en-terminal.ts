import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Terminal controls register with the lazy terminal; shared launch labels stay eager.
const enTerminal = {
  terminal: {
    title: en.terminal.title,
    find: "Find in terminal",
    findScope:
      "Case-sensitive text in retained visual rows. Wrapped phrases across rows are not searched. Refresh to include new output.",
    findCount: "{current} of {total}",
    findPrevious: "Previous match",
    findNext: "Next match",
    findRefresh: "Refresh terminal matches",
    findClose: "Close terminal find",
    availableSessions: "Available sessions",
    inputLabel: "Terminal input",
    sendInput: "Send terminal input",
    closeSessionTitle: "Close this terminal session?",
    closeSessionMessage: "Its running process will end.",
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
    uploadFailed: "Couldn’t upload the file. Try again.",
    retryUpload: "Retry",
    insertUploadedPaths: "Insert uploaded paths",
    uploadExpired: "Uploaded files may have expired. Cancel this batch and choose the files again.",
    closeSession: "Close terminal session",
    sessions: "Terminal sessions",
    refreshSessions: "Refresh",
    loadingSessions: "Loading sessions…",
    noSessions: "No terminal sessions yet.",
    currentSession: "current",
    sessionAttached: "attached",
    attachSession: "Attach session",
    attachFailed: "Couldn’t connect to this terminal session. Try again.",
    deliveryFailed:
      "Couldn’t confirm input delivery. Check the terminal before reconnecting and trying again.",
    inputPaused: "Couldn’t send input while disconnected. Reconnect to try again.",
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
    uploadTooLarge: "Couldn’t upload {file}. Choose a file smaller than 16 MiB.",
    uploadUnsafeCmdPath:
      "Couldn’t insert the file path into cmd.exe. Rename the file without % or ! and try again.",
    uploadUnsupportedShell: "Couldn’t insert the file path into {shell}. Use a supported shell.",
    uploadInvalidNativePath: "Couldn’t insert the file path. Check the path and try again.",
  },
} satisfies TranslationMap;

export const registerTerminalEnglish = Object.assign(
  () => {
    Object.assign(en.terminal, enTerminal.terminal);
  },
  { catalog: enTerminal },
);
