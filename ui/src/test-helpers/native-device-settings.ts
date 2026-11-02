import type { NativeDeviceSettingsSnapshot } from "../app/native-device-settings.ts";

type Present<T, K extends keyof T> = T & { [P in K]-?: NonNullable<T[P]> };
const deviceInfo = { appVersion: "2026.9.3", appBuild: "42", profileName: null };

function flags<const K extends string, const V extends boolean>(value: V, ...keys: K[]) {
  // SAFETY: every supplied key is mapped once to the same literal boolean.
  return Object.fromEntries(keys.map((key) => [key, value])) as Record<K, V>;
}

type NativeDeviceSettingsWithLocation = NativeDeviceSettingsSnapshot & {
  permissions: Present<NativeDeviceSettingsSnapshot["permissions"], "location">;
};

type MacDeviceSettingsSnapshot = Present<
  NativeDeviceSettingsWithLocation,
  "app" | "capabilities" | "updates"
> & {
  browser: Present<NonNullable<NativeDeviceSettingsSnapshot["browser"]>, "cookieSync">;
  voice: Present<NativeDeviceSettingsSnapshot["voice"], "microphone" | "locale">;
};

export function createNativeDeviceSettingsSnapshot(): MacDeviceSettingsSnapshot {
  return {
    contract: 1,
    device: { ...deviceInfo, platform: "macos" },
    app: {
      ...flags(true, "showDockIcon", "iconAnimationsEnabled", "quickChatEnabled"),
      ...flags(true, "launchAtLoginAvailable", "keepGatewayRunningAvailable"),
      ...flags(false, "nativeExperienceEnabled", "launchAtLogin"),
      ...flags(false, "keepGatewayRunning", "debugPaneEnabled"),
      iconStyle: {
        selectedId: "paper",
        available: [
          { id: "paper", name: "Original" },
          { id: "heritage", name: "Heritage" },
          { id: "clawmark", name: "Clawmark" },
          { id: "origami", name: "Origami" },
          { id: "pincer", name: "Pincer" },
          { id: "openC", name: "Open C" },
        ],
      },
      quickChatShortcut: "⌥Space",
    },
    capabilities: {
      ...flags(true, "canvasEnabled", "cameraEnabled", "desktopSharingEnabled"),
      ...flags(true, "computerControlEnabled", "peekabooBridgeEnabled"),
      ...flags(false, "cuaDriverBundled", "activeComputerPresenceEnabled"),
      ...flags(false, "unattendedDesktopEnabled"),
      computerControlProvider: "peekaboo",
    },
    desktopAvailability: { state: "unlocked" },
    browser: {
      chromeSetupActions: ["inspect", "install", "verify"],
      importAvailable: true,
      cookieSync: {
        available: true,
        enabled: false,
        domains: ["example.com"],
        targetProfile: "default",
        state: "off",
        detail: null,
      },
    },
    permissions: {
      entries: [
        { id: "notifications", status: "notDetermined" },
        { id: "accessibility", status: "denied" },
        { id: "screenRecording", status: "granted" },
        { id: "microphone", status: "notDetermined" },
        { id: "camera", status: "notDetermined" },
        { id: "speechRecognition", status: "granted" },
        { id: "location", status: "denied" },
      ],
      location: { mode: "off", precise: false },
    },
    voice: {
      ...flags(true, "supported", "wakeTriggersTalkMode", "pushToTalkEnabled"),
      ...flags(true, "talkPhaseSoundsEnabled", "talkShiftToStopEnabled"),
      ...flags(true, "triggerChime", "sendChime"),
      ...flags(false, "wakeEnabled", "realtimeRelayEnabled"),
      microphone: { selectedId: null, devices: [{ id: "builtin", name: "Built-in Microphone" }] },
      locale: {
        primary: "en-US",
        additional: [],
        available: [
          { id: "en-US", name: "English (US)" },
          { id: "de-DE", name: "German" },
        ],
      },
    },
    updates: { available: true, automatic: true, unavailableReason: null },
  };
}

export function createIosNativeDeviceSettingsSnapshot(): NativeDeviceSettingsWithLocation {
  return {
    contract: 1,
    device: { ...deviceInfo, platform: "ios", formFactor: "phone", modelName: "iPhone" },
    app: { appearance: "system", notificationsEnabled: true },
    capabilities: {
      ...flags(true, "cameraEnabled", "healthSummaryAvailable"),
      ...flags(false, "keepAwakeEnabled", "healthSummaryEnabled"),
    },
    permissions: {
      entries: [
        { id: "notifications", status: "granted" },
        { id: "camera", status: "notDetermined" },
        { id: "microphone", status: "granted" },
        { id: "speechRecognition", status: "granted" },
        { id: "location", status: "granted" },
        { id: "contacts", status: "limited" },
        { id: "calendars", status: "notDetermined" },
        { id: "reminders", status: "denied" },
        { id: "photos", status: "limited" },
      ],
      location: { mode: "whileUsing", precise: true, preciseEditable: false },
    },
    voice: {
      ...flags(true, "supported", "talkEnabled", "talkButtonEnabled"),
      ...flags(false, "wakeEnabled", "talkBackgroundEnabled", "speakerphoneEnabled"),
    },
  };
}

export function createTauriDeviceSettingsSnapshot(platform: "linux" | "windows" | "macos") {
  return {
    contract: 1,
    revision: 1,
    device: { ...deviceInfo, platform, formFactor: "desktop" },
    browser: { chromeSetupActions: ["inspect", "install", "verify"] },
    capabilities: { desktopSharingEnabled: true },
    desktopSharing: { state: "running" },
    permissions: { entries: [] },
    voice: { supported: false, wakeEnabled: false },
  } satisfies NativeDeviceSettingsSnapshot;
}
