import { z } from "zod";
import {
  nativeChromeExtensionSetupActionSchema,
  nativeChromeExtensionSetupResultSchema,
  type NativeChromeExtensionSetupAction,
  type NativeChromeExtensionSetupResult,
} from "./native-chrome-setup.ts";

const permissionIdSchema = z.enum([
  "notifications",
  "accessibility",
  "screenRecording",
  "microphone",
  "camera",
  "speechRecognition",
  "location",
  "automation", // Swift Capability.appleScript
  "contacts",
  "calendars",
  "reminders",
  "photos",
]);
type PermissionId = z.infer<typeof permissionIdSchema>;

const namedDevicesSchema = z.array(z.object({ id: z.string(), name: z.string() }));
const nativeDeviceSettingsSnapshotSchema = z.object({
  contract: z.literal(1),
  device: z.object({
    platform: z.enum(["macos", "ios"]),
    formFactor: z.enum(["phone", "pad", "desktop"]).optional(),
    modelName: z.string().optional(),
    appVersion: z.string(), // CFBundleShortVersionString
    appBuild: z.string(), // CFBundleVersion
    profileName: z.string().nullable(), // OPENCLAW_PROFILE name when active, else null
  }),
  app: z
    .object({
      appearance: z.enum(["system", "light", "dark"]).optional(),
      notificationsEnabled: z.boolean().optional(),
      showDockIcon: z.boolean().optional(),
      nativeExperienceEnabled: z.boolean().optional(),
      // Advertised by hosts with Dock icon selection.
      iconStyle: z.object({ selectedId: z.string(), available: namedDevicesSchema }).optional(),
      iconAnimationsEnabled: z.boolean().optional(),
      launchAtLogin: z.boolean().optional(),
      launchAtLoginAvailable: z.boolean().optional(), // false for named profiles or unbundled apps
      quickChatEnabled: z.boolean().optional(),
      quickChatShortcut: z.string().nullable().optional(), // human display string; null when unset
      debugPaneEnabled: z.boolean().optional(),
    })
    .optional(),
  capabilities: z
    .object({
      canvasEnabled: z.boolean().optional(),
      cameraEnabled: z.boolean().optional(),
      keepAwakeEnabled: z.boolean().optional(),
      healthSummaryAvailable: z.boolean().optional(),
      healthSummaryEnabled: z.boolean().optional(),
      computerControlEnabled: z.boolean().optional(),
      computerControlProvider: z.enum(["peekaboo", "cua"]).optional(),
      cuaDriverBundled: z.boolean().optional(),
      peekabooBridgeEnabled: z.boolean().optional(),
      activeComputerPresenceEnabled: z.boolean().optional(),
      unattendedDesktopEnabled: z.boolean().optional(),
    })
    .optional(),
  desktopAvailability: z.object({ state: z.enum(["locked", "unlocked", "unknown"]) }).optional(),
  browser: z
    .object({
      chromeSetupActions: z.array(nativeChromeExtensionSetupActionSchema).optional(),
      importAvailable: z.boolean(), // local mode with Chrome-family cookies available
      cookieSync: z.object({
        available: z.boolean(), // remote mode with an external CLI
        enabled: z.boolean(),
        domains: z.array(z.string()),
        targetProfile: z.string(),
        state: z.enum(["off", "idle", "running", "error"]),
        detail: z.string().nullable(), // human status line
      }),
    })
    .optional(),
  permissions: z.object({
    // Native hosts publish unique ids in display order; never sort or deduplicate them.
    entries: z
      .array(
        z.object({
          id: permissionIdSchema,
          status: z.enum(["granted", "denied", "notDetermined", "unavailable", "limited"]),
        }),
      )
      .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length),
    location: z.object({
      mode: z.enum(["off", "whileUsing", "always"]),
      precise: z.boolean(),
      preciseEditable: z.boolean().optional(),
    }),
  }),
  voice: z.object({
    supported: z.boolean(), // voice wake runtime available on this device
    wakeEnabled: z.boolean(), // AppState.swabbleEnabled
    wakeTriggersTalkMode: z.boolean().optional(),
    pushToTalkEnabled: z.boolean().optional(),
    talkPhaseSoundsEnabled: z.boolean().optional(),
    talkShiftToStopEnabled: z.boolean().optional(),
    realtimeRelayEnabled: z.boolean().optional(),
    triggerChime: z.boolean().optional(),
    sendChime: z.boolean().optional(),
    talkEnabled: z.boolean().optional(),
    talkButtonEnabled: z.boolean().optional(),
    talkBackgroundEnabled: z.boolean().optional(),
    speakerphoneEnabled: z.boolean().optional(),
    microphone: z
      .object({
        selectedId: z.string().nullable(), // null = System Default
        devices: namedDevicesSchema,
      })
      .optional(),
    locale: z
      .object({
        primary: z.string(),
        additional: z.array(z.string()),
        available: namedDevicesSchema,
      })
      .optional(),
  }),
  updates: z
    .object({
      available: z.boolean(), // Sparkle updater present and usable
      automatic: z.boolean(), // drives automatic checks and downloads
      unavailableReason: z.string().nullable(),
    })
    .optional(),
});

export type NativeDeviceSettingsSnapshot = z.infer<typeof nativeDeviceSettingsSnapshotSchema>;

export type SettingKey =
  | "app.appearance"
  | "app.notificationsEnabled"
  | "app.showDockIcon"
  | "app.nativeExperienceEnabled"
  | "app.iconStyle"
  | "app.iconAnimationsEnabled"
  | "app.launchAtLogin"
  | "app.quickChatEnabled"
  | "app.debugPaneEnabled"
  | "capabilities.canvasEnabled"
  | "capabilities.cameraEnabled"
  | "capabilities.keepAwakeEnabled"
  | "capabilities.healthSummaryEnabled"
  | "capabilities.computerControlEnabled"
  | "capabilities.computerControlProvider"
  | "capabilities.peekabooBridgeEnabled"
  | "capabilities.activeComputerPresenceEnabled"
  | "capabilities.unattendedDesktopEnabled"
  | "browser.cookieSync.enabled"
  | "browser.cookieSync.domains"
  | "browser.cookieSync.targetProfile"
  | "permissions.location.mode"
  | "permissions.location.precise"
  | "voice.wakeEnabled"
  | "voice.wakeTriggersTalkMode"
  | "voice.pushToTalkEnabled"
  | "voice.talkPhaseSoundsEnabled"
  | "voice.talkShiftToStopEnabled"
  | "voice.realtimeRelayEnabled"
  | "voice.triggerChime"
  | "voice.sendChime"
  | "voice.talkEnabled"
  | "voice.talkButtonEnabled"
  | "voice.talkBackgroundEnabled"
  | "voice.speakerphoneEnabled"
  | "voice.microphone" // value: string id | null
  | "voice.locale.primary" // value: string
  | "voice.locale.additional" // value: string[]
  | "updates.automatic";

type NativePanel =
  | "quick-chat-shortcut"
  | "microphone-test"
  | "browser-import"
  | "connection"
  | "gateways"
  | "debug"
  | "diagnostics"
  | "licenses"
  | "about"
  | "watch";

type NativeDeviceSettingsMessage =
  | { type: "status" }
  | { type: "set"; key: SettingKey; value: boolean | string | string[] | null }
  | { type: "request-permission"; id: PermissionId }
  | { type: "open-system-settings"; id: PermissionId }
  | { type: "open"; panel: NativePanel }
  | { type: "check-for-updates" }
  | { type: "chrome-extension-setup"; action: NativeChromeExtensionSetupAction }
  | { type: "install-chrome-extension" };

const legacyChromeInstallResultSchema = z.object({
  nativeHostRegistered: z.boolean(),
  installRequested: z.boolean(),
  discoveredProfiles: z.number().int().nonnegative(),
});
export type LegacyChromeInstallResult = z.infer<typeof legacyChromeInstallResultSchema>;

export type NativeDeviceSettingsCapability = {
  readonly snapshot: NativeDeviceSettingsSnapshot | null;
  subscribe(listener: (snapshot: NativeDeviceSettingsSnapshot) => void): () => void;
  set(key: SettingKey, value: boolean | string | string[] | null, onSettled?: () => void): void;
  requestPermission(id: PermissionId): void;
  openSystemSettings(id: PermissionId): void;
  openPanel(panel: NativePanel): void;
  checkForUpdates(): void;
  setupChromeExtension(
    action: NativeChromeExtensionSetupAction,
  ): Promise<NativeChromeExtensionSetupResult>;
  /** Released native contract-1 installation projection; not a second installer. */
  installChromeExtension?(): Promise<LegacyChromeInstallResult>;
  refresh(): void;
  dispose(): void;
};

type NativeDeviceSettingsWindow = Window & {
  __OPENCLAW_NATIVE_DEVICE_SETTINGS__?: unknown;
  webkit?: {
    messageHandlers?: {
      openclawDeviceSettings?: {
        postMessage: (message: NativeDeviceSettingsMessage) => Promise<unknown>;
      };
    };
  };
};

const CHANGE_EVENT = "openclaw:native-device-settings-changed";

export function createNativeDeviceSettingsCapability(): NativeDeviceSettingsCapability | null {
  if (typeof window === "undefined") {
    return null;
  }
  // SAFETY: the host adds optional WebKit fields; the handler and snapshot are validated below.
  const nativeWindow = window as NativeDeviceSettingsWindow;
  const handler = nativeWindow.webkit?.messageHandlers?.openclawDeviceSettings;
  if (typeof handler?.postMessage !== "function") {
    return null;
  }
  const postMessage = handler.postMessage;
  const post = postMessage.bind(handler);
  const initial = nativeDeviceSettingsSnapshotSchema.safeParse(
    nativeWindow["__OPENCLAW_NATIVE_DEVICE_SETTINGS__"],
  );
  let snapshot = initial.success ? initial.data : null;
  let disposed = false;
  const isCurrent = () =>
    !disposed &&
    nativeWindow.webkit?.messageHandlers?.openclawDeviceSettings === handler &&
    handler.postMessage === postMessage;
  const listeners = new Set<(snapshot: NativeDeviceSettingsSnapshot) => void>();
  const onChange = (event: Event) => {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    const next = nativeDeviceSettingsSnapshotSchema.safeParse(event.detail);
    if (!next.success) {
      return;
    }
    snapshot = next.data;
    listeners.forEach((listener) => listener(next.data));
  };
  const send = async (message: NativeDeviceSettingsMessage, onSettled?: () => void) => {
    try {
      const reply = await post(message);
      if (disposed) {
        return;
      }
      if (message.type === "set") {
        const result = nativeDeviceSettingsSnapshotSchema.safeParse(reply);
        if (!result.success) {
          throw new Error("Native settings returned an invalid edit result");
        }
        snapshot = result.data;
      }
    } catch (error) {
      console.warn("Native device settings request failed", error);
    }
    if (!disposed && message.type === "set") {
      // Clear the originating draft before notifying whichever page is now mounted.
      onSettled?.();
      const current = snapshot;
      if (current) {
        listeners.forEach((listener) => listener(current));
      }
    }
  };
  // System Settings can change permissions while the app is backgrounded.
  const refresh = () => void send({ type: "status" });
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("focus", refresh);
  refresh();
  return {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (key, value, onSettled) => void send({ type: "set", key, value }, onSettled),
    requestPermission: (id) => void send({ type: "request-permission", id }),
    openSystemSettings: (id) => void send({ type: "open-system-settings", id }),
    openPanel: (panel) => void send({ type: "open", panel }),
    checkForUpdates: () => void send({ type: "check-for-updates" }),
    async setupChromeExtension(action) {
      if (!isCurrent()) {
        throw new Error("Native device settings is unavailable");
      }
      if (!snapshot?.browser?.chromeSetupActions?.includes(action)) {
        throw new Error("This native host does not advertise that Chrome setup action");
      }
      const validatedAction = nativeChromeExtensionSetupActionSchema.parse(action);
      const reply = await post({ type: "chrome-extension-setup", action: validatedAction });
      const result = nativeChromeExtensionSetupResultSchema.safeParse(reply);
      if (
        !isCurrent() ||
        !snapshot?.browser?.chromeSetupActions?.includes(action) ||
        !result.success ||
        result.data.action !== action ||
        result.data.target.platform !== "darwin"
      ) {
        throw new Error("Native Chrome setup returned an invalid result");
      }
      return result.data;
    },
    async installChromeExtension() {
      if (!isCurrent() || snapshot?.device.platform !== "macos") {
        throw new Error("Native device settings is unavailable");
      }
      const reply = await post({ type: "install-chrome-extension" });
      const result = legacyChromeInstallResultSchema.safeParse(reply);
      if (!isCurrent() || !result.success) {
        throw new Error("Native Chrome setup returned an invalid result");
      }
      return result.data;
    },
    refresh,
    dispose() {
      disposed = true;
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("focus", refresh);
      listeners.clear();
    },
  };
}
