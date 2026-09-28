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
    thisMachine: "This machine",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    loading: "Loading desktop sources…",
    empty: "No desktop-capable sources are available.",
    sourceUnavailable: "The requested desktop is unavailable. Retry when the machine is ready.",
    macLocked:
      "This Mac is locked. Sign in through Screen Sharing or on the Mac to use computer control.",
    macLockStateUnknown:
      "This Mac’s lock state is unknown. Check the desktop before using computer control; Screen Sharing remains available for sign-in.",
    connect: "Connect",
    connecting: en.desktop.connecting,
    starting: "Starting your machine…",
    preparing: "Preparing the desktop…",
    takeControl: "Take control",
    switchToViewOnly: "Switch to view only",
    viewOnly: "View only",
    control: "Control",
    agentInputPaused:
      "You control this desktop. Agent input is paused until you switch to view only.",
    audio: {
      unavailable: "Audio unavailable",
      setupUnavailable:
        "Desktop audio setup is unavailable. Ask the operator to check that pulseaudio and pulseaudio-utils are installed, then restart the managed desktop.",
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
    actual: "Actual",
    match: "Match",
    sizing: "Desktop size",
    matchRequirement: "Match requires a VNC server that supports desktop resizing.",
    fitScreen: "Fit screen",
    actualSize: "Use actual size",
    back: "Back",
    disconnect: "Disconnect",
    reconnect: en.desktop.reconnect,
    passwordPrompt: "Enter the VNC password for this machine.",
    passwordLabel: "VNC password",
    accountPrompt:
      "Enter a macOS account allowed in System Settings → General → Sharing. Remote Management also requires Observe/Control permissions.",
    usernameLabel: "macOS username",
    accountPasswordLabel: "macOS password",
    controlTaken: "Another operator took control",
    controlTakenBy: "{operator} took control",
    disconnected: "Desktop disconnected: {reason}",
    closeCode: "connection closed with code {code}",
    unknownReason: "unknown reason",
    errors: {
      pictureInPictureFailed:
        "Could not open or update Picture-in-Picture. Check browser permissions and try again from the desktop viewer.",
      listFailed: "Could not load desktop sources: {error}",
      fullscreenFailed: "Could not change fullscreen mode: {error}",
      securityFailed: "Desktop security negotiation failed: {reason}",
      connectionFailed:
        "Reconnect. If it fails again, check the browser console and desktop service logs.",
    },
  },
} satisfies TranslationMap;

export const registerDesktopEnglish = Object.assign(
  () => Object.assign(en.desktop, enDesktop.desktop),
  { catalog: enDesktop },
);
