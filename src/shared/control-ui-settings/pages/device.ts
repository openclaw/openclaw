import { defineSettingsPage } from "../define.js";

// Settings of the native app this Control UI runs in; only the apps show these pages.
export const DEVICE_SETTINGS = defineSettingsPage({
  path: "/settings/device",
  title: "This device",
  settings: {
    "device.app.nativeExperienceEnabled": { label: "Native experience (experimental)" },
    "device.app.appearance": { label: "Appearance" },
    "device.app.notificationsEnabled": { label: "Notifications" },
    "device.app.showDockIcon": { label: "Show Dock icon" },
    "device.app.iconStyle": { label: "Dock icon" },
    "device.app.iconAnimationsEnabled": { label: "Icon animations" },
    "device.app.launchAtLogin": { label: "Launch at login" },
    "device.app.keepGatewayRunning": { label: "Keep OpenClaw running when the app is closed" },
    "device.app.quickChatEnabled": { label: "Quick chat enabled" },
    "device.app.quickChatShortcut": { label: "Quick chat shortcut" },
    "device.capabilities.canvasEnabled": { label: "Allow Canvas" },
    "device.capabilities.cameraEnabled": { label: "Allow camera" },
    "device.capabilities.keepAwakeEnabled": { label: "Keep awake" },
    "device.capabilities.healthSummaryEnabled": { label: "Health summaries" },
    "device.capabilities.computerControlEnabled": { label: "Allow computer control" },
    "device.capabilities.desktopSharingEnabled": { label: "Desktop sharing" },
    "device.capabilities.unattendedDesktopEnabled": { label: "Keep computer awake" },
    "device.capabilities.computerControlProvider": { label: "Computer control provider" },
    "device.capabilities.peekabooBridgeEnabled": { label: "Enable Peekaboo Bridge" },
    "device.chromeExtensionSetup": { label: "Set up Chrome on this device" },
    "device.browserImport": { label: "Browser logins" },
    "device.browser.cookieSync.enabled": { label: "Sync cookies to the remote computer" },
    "device.browser.cookieSync.domains": { label: "Domains" },
    "device.browser.cookieSync.targetProfile": { label: "Target profile" },
    "device.app.debugPaneEnabled": { label: "Show Debug tools" },
    "device.debugWindow": { label: "Debug window" },
    "device.panels.*": { label: "Device" },
  },
});

export const DEVICE_PERMISSIONS_SETTINGS = defineSettingsPage({
  path: "/settings/device/permissions",
  title: "This device > Permissions",
  settings: {
    "device.permissions.*": { label: "System access" },
    "device.permissions.location.mode": { label: "Location access" },
    "device.permissions.location.precise": { label: "Precise location" },
    "device.capabilities.activeComputerPresenceEnabled": {
      label: "System-wide presence detection",
    },
  },
});
