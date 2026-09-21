/* @vitest-environment jsdom */
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createIosNativeDeviceSettingsSnapshot,
  createNativeDeviceSettingsSnapshot,
  createTauriDeviceSettingsSnapshot,
} from "../test-helpers/native-device-settings.ts";
import {
  createNativeDeviceSettingsCapability,
  type NativeDeviceSettingsCapability,
} from "./native-device-settings.ts";

let capability: NativeDeviceSettingsCapability | null;
afterEach(() => {
  capability?.dispose();
  capability = null;
  vi.unstubAllGlobals();
});

function installBridge(snapshot: unknown = createNativeDeviceSettingsSnapshot()) {
  const post = vi.fn<(message: unknown) => Promise<unknown>>().mockResolvedValue(snapshot);
  vi.stubGlobal("webkit", { messageHandlers: { openclawDeviceSettings: { postMessage: post } } });
  vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
  capability = createNativeDeviceSettingsCapability();
  return post;
}
function publish(detail: unknown) {
  window.dispatchEvent(new CustomEvent("openclaw:native-device-settings-changed", { detail }));
}

describe("native device settings wire contract", () => {
  it.each([
    ["chromeExtensionStatus", "chrome-extension-status"],
    ["installChromeExtension", "install-chrome-extension"],
  ] as const)("validates %s results and forwards its exact native action", async (method, type) => {
    const post = installBridge();
    const result = {
      nativeHostRegistered: true,
      installRequested: true,
      installedProfiles: 1,
      discoveredProfiles: 0,
    };
    post.mockResolvedValueOnce(result);
    await expect(capability![method]()).resolves.toEqual(result);
    expect(post).toHaveBeenLastCalledWith({ type });
    post.mockResolvedValueOnce({ ...result, installedProfiles: -1 });
    await expect(capability![method]()).rejects.toThrow("invalid result");
    post.mockRejectedValueOnce(new Error("CLI unavailable"));
    await expect(capability![method]()).rejects.toThrow("CLI unavailable");
    const shippedReply = {
      nativeHostRegistered: true,
      installRequested: false,
      discoveredProfiles: 1,
    };
    post.mockResolvedValueOnce(shippedReply);
    if (method === "installChromeExtension") {
      await expect(capability![method]()).resolves.toEqual(shippedReply);
    } else {
      await expect(capability![method]()).rejects.toThrow("invalid result");
    }
  });
  it("exists only with the native message handler and reads the document-start snapshot", () => {
    vi.stubGlobal("webkit", undefined);
    expect(createNativeDeviceSettingsCapability()).toBeNull();
    const post = installBridge();
    expect(capability?.snapshot).toEqual(createNativeDeviceSettingsSnapshot());
    expect(post.mock.calls).toEqual([[{ type: "status" }]]);
  });

  it("accepts hosts that do not advertise Dock icon selection", () => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    delete snapshot.app.iconStyle;
    installBridge(snapshot);
    expect(capability?.snapshot).toEqual(snapshot);
  });

  it("accepts the iOS snapshot with only its published fields", () => {
    const snapshot = createIosNativeDeviceSettingsSnapshot();
    installBridge(snapshot);
    expect(capability?.snapshot).toEqual(snapshot);
  });

  it.each(["linux", "windows", "macos"] as const)(
    "accepts the %s companion's desktop setting without location access",
    (platform) => {
      const snapshot = createTauriDeviceSettingsSnapshot(platform);
      installBridge(snapshot);
      expect(capability?.snapshot).toEqual(snapshot);
      const listener = vi.fn();
      capability?.subscribe(listener);
      const failed = {
        ...snapshot,
        revision: 2,
        desktopSharing: {
          state: "error",
          detail: "Install the OpenClaw CLI to share this desktop.",
        },
      };
      publish(failed);
      expect(capability?.snapshot).toEqual(failed);
      expect(listener).toHaveBeenCalledWith(failed);
    },
  );

  it("keeps a newer native event when an earlier edit reply settles", async () => {
    const initial = createTauriDeviceSettingsSnapshot("linux");
    const post = installBridge(initial);
    const delayed = createDeferred<unknown>();
    post.mockReturnValueOnce(delayed.promise);
    const listener = vi.fn();
    const settled = vi.fn();
    capability!.subscribe(listener);
    capability!.set("capabilities.desktopSharingEnabled", false, settled);
    const stopped = {
      ...initial,
      revision: 3,
      capabilities: { desktopSharingEnabled: false },
      desktopSharing: { state: "off" },
    };
    publish(stopped);
    delayed.resolve({
      ...stopped,
      revision: 2,
      desktopSharing: { state: "starting" },
    });
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    expect(capability!.snapshot?.desktopSharing?.state).toBe("off");
    expect(capability!.snapshot?.revision).toBe(3);
    expect(listener.mock.calls.every(([snapshot]) => snapshot.desktopSharing.state === "off")).toBe(
      true,
    );
    listener.mockClear();
    publish(initial);
    publish({ ...initial, revision: undefined });
    publish(stopped);
    expect(listener).not.toHaveBeenCalled();
    expect(capability!.snapshot).toEqual(stopped);
  });

  it("accepts absent optional families and voice fields", () => {
    const { device, permissions } = createNativeDeviceSettingsSnapshot();
    const snapshot = {
      contract: 1,
      device,
      permissions,
      voice: { supported: false, wakeEnabled: false },
    };
    installBridge(snapshot);
    expect(capability?.snapshot).toEqual(snapshot);
  });

  it.each([
    { state: "locked", enabled: true },
    { state: "unlocked", enabled: false },
    { state: "unknown", enabled: true },
    { state: undefined, enabled: undefined },
  ] as const)(
    "preserves published desktop state $state and hosting $enabled",
    ({ state, enabled }) => {
      installBridge();
      const listener = vi.fn();
      capability?.subscribe(listener);
      const snapshot = createNativeDeviceSettingsSnapshot();
      if (state === undefined) {
        delete snapshot.desktopAvailability;
        delete snapshot.capabilities.unattendedDesktopEnabled;
      } else {
        snapshot.desktopAvailability = { state };
        snapshot.capabilities.unattendedDesktopEnabled = enabled;
      }
      publish(snapshot);
      expect(capability?.snapshot).toEqual(snapshot);
      expect(listener).toHaveBeenCalledWith(snapshot);
    },
  );

  it.each([
    { name: "empty", entries: [] },
    { name: "single", entries: [{ id: "camera", status: "granted" }] },
    {
      name: "requestable macOS",
      entries: [
        { id: "screenRecording", status: "notDetermined" },
        { id: "accessibility", status: "notDetermined" },
      ],
    },
    {
      name: "reordered",
      entries: createNativeDeviceSettingsSnapshot().permissions.entries.toReversed(),
    },
  ])("accepts $name permission subsets in host-published order", ({ entries }) => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    const next = { ...snapshot, permissions: { ...snapshot.permissions, entries } };
    installBridge();
    const listener = vi.fn();
    capability?.subscribe(listener);
    publish(next);
    expect(capability?.snapshot).toEqual(next);
    expect(listener).toHaveBeenCalledWith(next);
  });

  it("accepts shipped Mac snapshots without exposing their retired Terminal permission", () => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    snapshot.device.appVersion = "2026.9.5";
    // The v2026.9.5 native permission list always included automation, even when unavailable.
    const shippedSnapshot = {
      ...snapshot,
      permissions: {
        ...snapshot.permissions,
        entries: [...snapshot.permissions.entries, { id: "automation", status: "unavailable" }],
      },
    };
    installBridge(shippedSnapshot);
    expect(capability?.snapshot).toEqual(snapshot);

    const listener = vi.fn();
    capability?.subscribe(listener);
    const updated = { ...snapshot, app: { ...snapshot.app, showDockIcon: false } };
    publish({ ...shippedSnapshot, app: updated.app });
    expect(capability?.snapshot).toEqual(updated);
    expect(listener).toHaveBeenCalledWith(updated);
    expectTypeOf<
      Extract<Parameters<NativeDeviceSettingsCapability["requestPermission"]>[0], "automation">
    >().toBeNever();
    expectTypeOf<
      Extract<Parameters<NativeDeviceSettingsCapability["openSystemSettings"]>[0], "automation">
    >().toBeNever();
  });

  it.each([
    ["contract", { contract: 2 }],
    ["negative revision", { revision: -1 }],
    ["fractional revision", { revision: 1.5 }],
    ["non-numeric revision", { revision: "2" }],
    ["device", { device: { platform: "macos" } }],
    ["app", { app: { ...createNativeDeviceSettingsSnapshot().app, showDockIcon: "yes" } }],
    ["absent family encoded as null", { app: null }],
    ["appearance", { app: { appearance: "sepia" } }],
    ["notifications", { app: { notificationsEnabled: "true" } }],
    ["native experience", { app: { nativeExperienceEnabled: "true" } }],
    ["iOS capability", { capabilities: { healthSummaryEnabled: "true" } }],
    ["unattended desktop toggle", { capabilities: { unattendedDesktopEnabled: "true" } }],
    ["desktop sharing toggle", { capabilities: { desktopSharingEnabled: "true" } }],
    ...[null, {}, { state: "available" }, { state: true }].map(
      (desktopAvailability) => ["desktop availability", { desktopAvailability }] as const,
    ),
    ...[
      null,
      { selectedId: 1, available: [] },
      { selectedId: "paper", available: [{ id: "paper" }] },
    ].map(
      (iconStyle) =>
        ["Dock icon", { app: { ...createNativeDeviceSettingsSnapshot().app, iconStyle } }] as const,
    ),
    [
      "capabilities",
      {
        capabilities: {
          ...createNativeDeviceSettingsSnapshot().capabilities,
          computerControlProvider: "other",
        },
      },
    ],
    [
      "browser",
      {
        browser: {
          importAvailable: true,
          cookieSync: { ...createNativeDeviceSettingsSnapshot().browser.cookieSync, domains: [42] },
        },
      },
    ],
    [
      "permissions",
      { permissions: { ...createNativeDeviceSettingsSnapshot().permissions, entries: null } },
    ],
    [
      "unknown permission id",
      {
        permissions: {
          ...createNativeDeviceSettingsSnapshot().permissions,
          entries: [{ id: "unknown", status: "granted" }],
        },
      },
    ],
    [
      "duplicate permission id",
      {
        permissions: {
          ...createNativeDeviceSettingsSnapshot().permissions,
          entries: [
            { id: "camera", status: "granted" },
            { id: "camera", status: "denied" },
          ],
        },
      },
    ],
    [
      "precise editability",
      {
        permissions: {
          ...createIosNativeDeviceSettingsSnapshot().permissions,
          location: { mode: "whileUsing", precise: true, preciseEditable: "false" },
        },
      },
    ],
    ["missing voice wakeEnabled", { voice: { supported: true } }],
    ["missing voice supported", { voice: { wakeEnabled: false } }],
    ["Talk toggle", { voice: { supported: true, wakeEnabled: false, talkEnabled: "true" } }],
    [
      "location",
      {
        permissions: {
          ...createNativeDeviceSettingsSnapshot().permissions,
          location: { mode: ["off"], precise: false },
        },
      },
    ],
    [
      "voice",
      {
        voice: {
          ...createNativeDeviceSettingsSnapshot().voice,
          microphone: { selectedId: null, devices: [{ id: "mic" }] },
        },
      },
    ],
    ["updates", { updates: { available: true, automatic: true } }],
  ] as const)("ignores malformed %s snapshots without notifying subscribers", (_name, change) => {
    installBridge();
    const listener = vi.fn();
    capability?.subscribe(listener);
    publish({ ...createNativeDeviceSettingsSnapshot(), ...change });
    expect(capability?.snapshot).toEqual(createNativeDeviceSettingsSnapshot());
    expect(listener).not.toHaveBeenCalled();
  });

  it("waits for a valid snapshot and stops notifications after unsubscribe/dispose", () => {
    const post = installBridge(null);
    expect(capability?.snapshot).toBeNull();
    const listener = vi.fn();
    const unsubscribe = capability?.subscribe(listener);
    const next = createNativeDeviceSettingsSnapshot();
    next.app.showDockIcon = false;
    publish(next);
    expect(capability?.snapshot?.app?.showDockIcon).toBe(false);
    expect(listener).toHaveBeenCalledWith(next);
    unsubscribe?.();
    publish(createNativeDeviceSettingsSnapshot());
    expect(listener).toHaveBeenCalledTimes(1);
    post.mockClear();
    window.dispatchEvent(new Event("focus"));
    capability?.refresh();
    expect(post.mock.calls).toEqual([[{ type: "status" }], [{ type: "status" }]]);
    capability?.dispose();
    post.mockClear();
    window.dispatchEvent(new Event("focus"));
    publish(next);
    expect(post).not.toHaveBeenCalled();
    expect(capability?.snapshot?.app?.showDockIcon).toBe(true);
  });

  it("settles a rejected edit with native state before notifying the current subscriber", async () => {
    const post = installBridge();
    const reply = createDeferred<unknown>();
    post.mockReturnValueOnce(reply.promise);
    let pending = "rejected-profile";
    const settled = vi.fn(() => {
      pending = "";
    });
    capability!.set("browser.cookieSync.targetProfile", pending, settled);
    const observed: string[] = [];
    capability!.subscribe(() =>
      observed.push(pending || capability!.snapshot!.browser!.cookieSync.targetProfile),
    );
    reply.resolve(createNativeDeviceSettingsSnapshot());
    await vi.waitFor(() => expect(observed).toEqual(["default"]));
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("settles transport rejection without changing native state and ignores replies after disposal", async () => {
    const post = installBridge();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejected = createDeferred<unknown>();
    post.mockReturnValueOnce(rejected.promise);
    const settled = vi.fn();
    const listener = vi.fn();
    capability!.subscribe(listener);
    capability!.set("browser.cookieSync.targetProfile", "rejected", settled);
    rejected.reject(new Error("Document retired"));
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    expect(listener).toHaveBeenCalledWith(createNativeDeviceSettingsSnapshot());
    expect(warning).toHaveBeenCalledTimes(1);
    const delayed = createDeferred<unknown>();
    post.mockReturnValueOnce(delayed.promise);
    capability!.set("app.showDockIcon", false, settled);
    capability!.dispose();
    const next = createNativeDeviceSettingsSnapshot();
    next.app.showDockIcon = false;
    delayed.resolve(next);
    await delayed.promise;
    expect(capability!.snapshot!.app?.showDockIcon).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  it("posts exact native commands without optimistically changing the owner snapshot", () => {
    const post = installBridge();
    post.mockClear();
    capability?.set("app.showDockIcon", false);
    capability?.set("app.nativeExperienceEnabled", true);
    capability?.set("app.iconStyle", "origami");
    capability?.set("voice.microphone", null);
    capability?.set("browser.cookieSync.domains", ["example.com"]);
    capability?.set("voice.locale.primary", "de-DE");
    capability?.requestPermission("microphone");
    capability?.openSystemSettings("accessibility");
    capability?.openPanel("quick-chat-shortcut");
    capability?.checkForUpdates();
    expect(post.mock.calls.map(([message]) => message)).toEqual([
      { type: "set", key: "app.showDockIcon", value: false },
      { type: "set", key: "app.nativeExperienceEnabled", value: true },
      { type: "set", key: "app.iconStyle", value: "origami" },
      { type: "set", key: "voice.microphone", value: null },
      { type: "set", key: "browser.cookieSync.domains", value: ["example.com"] },
      { type: "set", key: "voice.locale.primary", value: "de-DE" },
      { type: "request-permission", id: "microphone" },
      { type: "open-system-settings", id: "accessibility" },
      { type: "open", panel: "quick-chat-shortcut" },
      { type: "check-for-updates" },
    ]);
    expect(capability?.snapshot?.app?.showDockIcon).toBe(true);
    expect(capability?.snapshot?.app?.iconStyle?.selectedId).toBe("paper");
  });
});
