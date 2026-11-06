import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Viewer copy loads with Desktop; shell and setup labels stay in the startup catalog.
const enDesktop = {
  desktop: {
    title: en.desktop.title,
    openWindow: en.desktop.openWindow,
    unavailable: en.desktop.unavailable,
    toggle: en.desktop.toggle,
    hide: "Hide desktop panel",
    resize: "Resize desktop panel",
    dockBottom: "Dock to bottom",
    dockRight: "Dock to right",
    enterFullscreen: "Enter fullscreen",
    exitFullscreen: "Exit fullscreen",
    fullscreenUnavailable: "Fullscreen is unavailable in this browser",
    enterPictureInPicture: "Open desktop in Picture-in-Picture",
    exitPictureInPicture: "Close Picture-in-Picture",
    pictureInPictureTitle: "Desktop — view-only Picture-in-Picture",
    pictureInPictureUnavailable:
      "Picture-in-Picture requires a supported browser and a secure connection",
    pickerTitle: "Desktop sources",
    availableDesktops: "Available desktops",
    thisMachine: "This computer",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    loading: "Loading desktop sources…",
    empty: "No desktop sources yet.",
    sourceUnavailable: "This desktop is unavailable. Try again when the device is ready.",
    hostDesktopOff:
      "Desktop access isn’t enabled on this computer. This panel shares this computer’s screen, not the device running your browser.",
    hostDesktopEnableHint: "Enable desktop access to view and control this computer in OpenClaw.",
    hostScreenSharingSetupHint:
      "On this Mac, open System Settings → General → Sharing. Turn on Screen Sharing, or allow this computer’s account to Observe and Control in Remote Management, then check again.",
    hostDesktopServerSetupHint:
      "Set up a password-protected VNC server on this computer, or configure a managed desktop on Linux, then check again.",
    hostScreenSharingAccount:
      "Screen Sharing signs in with a macOS account on this computer. A sign-in prompt follows after you enable access.",
    hostDesktopServerAccount:
      "The desktop server on this computer uses its own password. A sign-in prompt may follow after you enable access.",
    screenSharingNetwork:
      "Screen Sharing may also be reachable from other devices on your network.",
    desktopServerNetwork: "The desktop server may be reachable from other devices on your network.",
    macLocked:
      "This Mac is locked. Sign in through Screen Sharing or on the Mac to use computer control.",
    macLockStateUnknown:
      "This Mac’s lock state is unknown. Check the desktop before using computer control; Screen Sharing remains available for sign-in.",
    connect: "Connect",
    connecting: en.desktop.connecting,
    starting: "Starting your device…",
    preparing: "Preparing the desktop…",
    takeControl: "Take control",
    clickToTakeControl: "Click to take control",
    takingControl: "Taking control…",
    switchingToViewing: "Switching to view only…",
    controlling: "Controlling",
    connectionLost: "Disconnected",
    connectionError: "Couldn’t connect to the desktop. Try again.",
    inventoryError: "Couldn’t load desktops. Try again.",
    credentialsTitle: "Connect to desktop",
    emptyTitle: "No desktops yet",
    backToViewing: "Back to viewing",
    connected: "Connected",
    gatewayHost: "This computer",
    moreActions: "Desktop actions",
    expandPanel: "Expand panel",
    collapsePanel: "Collapse panel",
    switchToViewOnly: "Switch to view only",
    viewOnly: "View only",
    control: "Control",
    audio: {
      unavailable: "Audio unavailable",
      setupUnavailable:
        "Desktop audio setup is unavailable. Ask an admin to check that pulseaudio and pulseaudio-utils are installed, then restart the managed desktop.",
      reconnect: "Reconnect desktop for audio",
      connecting: "Connecting desktop audio…",
      unmute: "Unmute desktop audio",
      mute: "Mute desktop audio",
      blocked:
        "Audio playback was blocked. Allow sound for this site, then click Unmute desktop audio again.",
      unsupported:
        "Desktop audio requires a browser with Web Audio support. Try a current browser.",
      failed: "Desktop audio disconnected or could not start. Reconnect the desktop to try again.",
    },
    keyboard: "Keyboard",
    keyboardInput: "Remote desktop keyboard input",
    touchControls: "Remote desktop controls",
    fit: "Fit",
    fitHeight: "Fit height",
    fitWidth: "Fit width",
    actual: "Actual",
    actualSizeLabel: "Actual size",
    match: "Match",
    sizing: "Desktop size",
    matchRequirement: "Match requires a VNC server that supports desktop resizing.",
    fitScreen: "Fit screen",
    actualSize: "Use actual size",
    back: "Back",
    disconnect: "Disconnect",
    reconnect: en.desktop.reconnect,
    passwordPrompt: "Enter the VNC password for this device.",
    passwordLabel: "VNC password",
    accountPrompt:
      "Enter a macOS account allowed in System Settings → General → Sharing. Remote Management also requires Observe/Control permissions.",
    usernameLabel: "macOS username",
    accountPasswordLabel: "macOS password",
    controlTaken: "Someone else took control",
    controlTakenBy: "{operator} took control",
    disconnected: "Desktop disconnected: {reason}",
    disconnectedClean: "Desktop disconnected",
    closeCode: "connection closed with code {code}",
    unknownReason: "unknown reason",
    errors: {
      pictureInPictureFailed:
        "Couldn’t open or update Picture-in-Picture. Check browser permissions and try again from the desktop viewer.",
      listFailed: "Couldn’t load desktop sources. Try again. {error}",
      fullscreenFailed: "Couldn’t change fullscreen mode. Try again. {error}",
      securityFailed: "Couldn’t secure the desktop connection. Reconnect to try again. {reason}",
      connectionFailed:
        "Reconnect. If it fails again, check the browser console and desktop service logs.",
    },
  },
} satisfies TranslationMap;

export const registerDesktopEnglish = Object.assign(
  () => Object.assign(en.desktop, enDesktop.desktop),
  { catalog: enDesktop },
);
