import type { NativeDeviceSettingsSnapshot } from "../app/native-device-settings.ts";

type NativeDeviceSettingsWithLocation = NativeDeviceSettingsSnapshot & {
  permissions: NativeDeviceSettingsSnapshot["permissions"] & {
    location: NonNullable<NativeDeviceSettingsSnapshot["permissions"]["location"]>;
  };
};

type MacDeviceSettingsSnapshot = NativeDeviceSettingsWithLocation & {
  app: NonNullable<NativeDeviceSettingsSnapshot["app"]>;
  capabilities: NonNullable<NativeDeviceSettingsSnapshot["capabilities"]>;
  browser: NonNullable<NativeDeviceSettingsSnapshot["browser"]> & {
    cookieSync: NonNullable<NonNullable<NativeDeviceSettingsSnapshot["browser"]>["cookieSync"]>;
  };
  voice: NativeDeviceSettingsSnapshot["voice"] &
    Required<Pick<NativeDeviceSettingsSnapshot["voice"], "microphone" | "locale">>;
  updates: NonNullable<NativeDeviceSettingsSnapshot["updates"]>;
};

export function createNativeDeviceSettingsSnapshot(): MacDeviceSettingsSnapshot {
  return {
    contract: 1,
    device: { platform: "macos", appVersion: "2026.9.3", appBuild: "42", profileName: null },
    app: {
      showDockIcon: true,
      nativeExperienceEnabled: false,
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
      iconAnimationsEnabled: true,
      launchAtLogin: false,
      launchAtLoginAvailable: true,
      quickChatEnabled: true,
      quickChatShortcut: "⌥Space",
      debugPaneEnabled: false,
    },
    capabilities: {
      canvasEnabled: true,
      cameraEnabled: true,
      computerControlEnabled: true,
      desktopSharingEnabled: true,
      computerControlProvider: "peekaboo",
      cuaDriverBundled: false,
      peekabooBridgeEnabled: true,
      activeComputerPresenceEnabled: false,
      unattendedDesktopEnabled: false,
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
      supported: true,
      wakeEnabled: false,
      wakeTriggersTalkMode: true,
      pushToTalkEnabled: true,
      talkPhaseSoundsEnabled: true,
      talkShiftToStopEnabled: true,
      talkSpokenExitAcknowledgementEnabled: false,
      talkStopPhrases: ["stop talking", "end talking"],
      realtimeRelayEnabled: false,
      triggerChime: true,
      sendChime: true,
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
    device: {
      platform: "ios",
      formFactor: "phone",
      modelName: "iPhone",
      appVersion: "2026.9.3",
      appBuild: "42",
      profileName: null,
    },
    app: { appearance: "system", notificationsEnabled: true },
    capabilities: {
      cameraEnabled: true,
      keepAwakeEnabled: false,
      healthSummaryAvailable: true,
      healthSummaryEnabled: false,
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
      supported: true,
      wakeEnabled: false,
      talkEnabled: true,
      talkButtonEnabled: true,
      talkBackgroundEnabled: false,
      speakerphoneEnabled: false,
    },
  };
}

export function createTauriDeviceSettingsSnapshot(platform: "linux" | "windows" | "macos") {
  return {
    contract: 1,
    revision: 1,
    device: {
      platform,
      formFactor: "desktop",
      appVersion: "2026.9.3",
      appBuild: "42",
      profileName: null,
    },
    browser: { chromeSetupActions: ["inspect", "install", "verify"] },
    capabilities: { desktopSharingEnabled: true },
    desktopSharing: { state: "running" },
    permissions: { entries: [] },
    voice: { supported: false, wakeEnabled: false },
  } satisfies NativeDeviceSettingsSnapshot;
}
