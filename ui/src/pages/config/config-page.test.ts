/* @vitest-environment jsdom */

import { createRouter, definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import { createApplicationTheme } from "../../app/bootstrap-theme.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createNativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { mountRouterOutlet } from "../../app/router-outlet.test-support.tsx";
import { changedServerUiPrefs } from "../../app/server-prefs-intent.ts";
import { canSyncAppearancePreference } from "../../app/server-prefs-profile-runtime.ts";
import {
  applyServerUiPrefs,
  refreshProfileAppearancePrefs,
} from "../../app/server-prefs-reconcile.ts";
import { createServerPrefsWriter } from "../../app/server-prefs.test-support.ts";
import {
  flushServerUiPrefs,
  pushServerUiPrefs,
  resetServerUiPrefsSync,
} from "../../app/server-prefs.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import type { WebPushSnapshot } from "../../app/web-push.ts";
import {
  installDialogPolyfill,
  nextFrame,
  waitForRenderedModalDialog,
} from "../../test-helpers/modal-dialog.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import * as realtimeTalk from "../chat/talk/session.ts";
import {
  completeConfigContext,
  mountConfigPage,
  mountConfigPageState,
  publishConfigSource,
} from "./config-page.test-support.ts";
import type { ConfigPageId, ConfigPageRouteData } from "./config-page.tsx";
import { pages } from "./route.ts";
import { extractQuickSettingsSecurity } from "./security.tsx";

const switchActiveRealtimeTalkCameras =
  vi.fn<typeof realtimeTalk.switchActiveRealtimeTalkCameras>();

// Mount helpers fill capabilities unrelated to each scenario.
function configContext(overrides: object = {}) {
  return {
    gateway: { snapshot: { phase: "disconnected" } },
    ...overrides,
  } as unknown as ApplicationContext;
}

function stubCameraDevices() {
  vi.stubGlobal("navigator", {
    mediaDevices: Object.assign(new EventTarget(), {
      enumerateDevices: vi
        .fn()
        .mockResolvedValue([{ kind: "videoinput", deviceId: "camera-1", label: "Desk Camera" }]),
      getUserMedia: vi.fn(),
    }),
  });
}

const auth = (scopes = ["operator.admin"]) => ({ role: "operator", scopes });
const connectedGateway = (methods: string[]) => ({
  snapshot: {
    client: {},
    phase: "connected",
    hello: { auth: auth(), features: { methods } },
  },
});

function profileContext(
  gatewayUrl: string,
  profileId: string | null,
  config: object | null,
  scopes = ["operator.write"],
) {
  return configContext({
    gateway: {
      connection: { gatewayUrl },
      snapshot: {
        selfUser: profileId ? { id: profileId } : null,
        hello: { auth: auth(scopes) },
      },
    },
    runtimeConfig: {
      state: { connected: config !== null, configSnapshot: config === null ? null : { config } },
      canPatch: false,
    },
    theme: { refresh: vi.fn() },
  });
}

async function loadProfile(configObject: object, entries: Record<string, string>) {
  const scope = "ws://profile.test";
  const profileId = "profile-owner";
  const client = {
    request: vi.fn(async () => ({ status: "ok", entries })),
  } as unknown as GatewayBrowserClient;
  const context = completeConfigContext(profileContext(scope, profileId, configObject));
  const theme = createApplicationTheme(loadSettings(scope), context.gateway);
  Object.assign(context, { theme });
  onTestFinished(() => theme.dispose());
  await refreshProfileAppearancePrefs({
    configObject,
    scope,
    profileId,
    onApplied: vi.fn(),
    client,
  });
  const previous = loadSettings();
  const props = mountConfigPageState(context).state.configProps;
  return { context, previous, props };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  vi.spyOn(realtimeTalk, "switchActiveRealtimeTalkCameras").mockImplementation(
    switchActiveRealtimeTalkCameras,
  );
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
  switchActiveRealtimeTalkCameras.mockReset();
  switchActiveRealtimeTalkCameras.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanupSolid();
  resetServerUiPrefsSync();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("distinguishes explicit values that equal the defaults", () => {
  const config = { browser: { enabled: true }, tools: { profile: "full" } };
  expect(extractQuickSettingsSecurity(config)).toMatchObject({
    browserEnabled: true,
    browserEnabledOverridden: true,
    toolProfile: "full",
    toolProfileOverridden: true,
  });
});

it("refreshes notification presentation from in-place owner publications", () => {
  let publishNotifications = () => {};
  const snapshot: NonNullable<ApplicationContext["nativeNotifications"]>["snapshot"] = {
    permission: "granted",
    test: { state: "sent" },
  };
  const nativeNotifications = {
    snapshot,
    subscribe: (notify: () => void) => {
      publishNotifications = notify;
      return () => {
        publishNotifications = () => {};
      };
    },
  };
  const context = configContext({ nativeNotifications });
  const { state } = mountConfigPageState(context, { pageId: "notifications" });
  expect(state.configProps().nativeNotifications?.test?.state).toBe("sent");

  snapshot.test = { state: "pending" };
  publishNotifications();
  flush();
  expect(state.configProps().nativeNotifications?.test?.state).toBe("pending");

  Object.assign(context.webPush.snapshot, { loading: true });
  publishConfigSource(context.webPush);
  expect(state.configProps().webPush?.loading).toBe(true);
});

it("renders Web Push registration publications and dispatches Unsubscribe without reloading", () => {
  const snapshot: WebPushSnapshot = {
    supported: true,
    canManage: true,
    canReadPreferences: true,
    permission: "default",
    subscription: "unknown",
    loading: false,
  };
  const run = vi.fn();
  const webPush = { snapshot, run };
  const context = configContext({
    webPush,
    runtimeConfig: { state: { connected: true } },
  });
  const { container } = mountConfigPage(context, { pageId: "notifications" });
  expect(container.textContent).toContain("Checking");
  expect(container.textContent).toContain("Not requested");

  snapshot.loading = true;
  publishConfigSource(webPush);
  const enable = container.querySelector<HTMLButtonElement>("button.btn.primary")!;
  expect(enable.textContent).toContain("Subscribing");
  expect(enable.disabled).toBe(true);

  const user = {
    categories: {
      approvalRequested: true,
      agentFinished: true,
      agentQuestion: true,
      humanMentioned: true,
      scheduledTaskFailed: true,
    },
    detailLevel: "private" as const,
    quietHours: { enabled: false, startMinute: 1320, endMinute: 420, timeZone: "UTC" },
    agentIds: [],
  };
  const device = { enabled: true, label: "Settings test browser" };
  snapshot.permission = "granted";
  snapshot.subscription = "registered";
  snapshot.loading = false;
  snapshot.preferences = { durableIdentity: true, user, device, effective: { ...user, ...device } };
  publishConfigSource(webPush);
  expect(container.textContent).toContain("Granted");
  expect(container.textContent).toContain("Subscribed");
  expect(container.textContent).not.toContain("Checking");
  expect(
    container.querySelector<HTMLInputElement>('input[aria-label="Notification label"]')?.value,
  ).toBe("Settings test browser");
  const unsubscribe = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === "Unsubscribe",
  )!;
  expect(unsubscribe.disabled).toBe(false);
  unsubscribe.click();
  expect(run).toHaveBeenCalledExactlyOnceWith({ kind: "disable" });
});

it.each([
  ["profile writer", { id: "profile-owner" }, "operator.write", false, true, false],
  ["read-only profile", { id: "profile-viewer" }, "operator.read", true, false, true],
  ["no bound profile", null, "operator.write", false, false, false],
] as const)("sync authorization: %s", (_label, selfUser, scope, canPatch, appearance, locale) => {
  const context = configContext({
    gateway: { snapshot: { selfUser, hello: { auth: auth([scope]) } } },
    runtimeConfig: { state: { connected: true }, canPatch },
  });

  for (const key of ["theme", "themeMode", "accent", "fontUi", "fontChat", "tabIcon"] as const) {
    expect(canSyncAppearancePreference(context, key)).toBe(appearance);
  }
  expect(canSyncAppearancePreference(context)).toBe(locale);
});

it("restores the gateway appearance default while queuing deletion of the profile override", async () => {
  const configObject = { ui: { prefs: { theme: "dash" } } };
  const { context, props, previous } = await loadProfile(configObject, { "ui.theme": "knot" });
  props().setTheme("dash");

  expect(loadSettings().theme).toBe("dash");
  expect(context.theme.settings.theme).toBe("dash");
  expect(changedServerUiPrefs(previous, loadSettings())).toEqual({
    theme: null,
    accent: "theme",
    fontUi: null,
    fontChat: null,
  });
});

it.each([
  ["loading", undefined],
  ["disconnected", undefined],
  ["before-load-disconnect", "#55bb77"],
] as const)(
  "reconciles the returned accent after a %s reset with server value %s",
  async (connection, returnedAccent) => {
    const profileId = "profile-viewer";
    const scope = "ws://profile.test";
    const configObject = { ui: { prefs: { accent: "#abcdef" } } };
    const saved = { status: "ok", entries: { "ui.accent": "#123456" } };
    const initial = createServerPrefsWriter(
      vi.fn(async () => saved),
      scope,
    );
    const options = { profileId, configObject, scope, onApplied: vi.fn() };
    patchSettings({ gatewayUrl: scope });
    await refreshProfileAppearancePrefs({ ...options, client: initial.state.client! });
    resetServerUiPrefsSync();
    flushServerUiPrefs(initial, { profileId, canWrite: false });
    patchSettings({ accent: "#654321" });
    pushServerUiPrefs(initial, { accent: "#654321" }, { profileId, canWrite: false });

    const delayed = deferred<unknown>();
    const request = vi.fn((_method: string) => delayed.promise);
    const writer = createServerPrefsWriter(request, scope);
    const connected = connection === "loading";
    let pending: Promise<boolean> | undefined;
    if (connection !== "before-load-disconnect") {
      applyServerUiPrefs(configObject, options);
      pending = refreshProfileAppearancePrefs({ ...options, client: writer.state.client! });
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    }
    const context = profileContext(
      scope,
      connected ? profileId : null,
      connected ? configObject : null,
      ["operator.read"],
    );
    const previous = loadSettings();
    const { state } = mountConfigPageState(context);
    state.configProps().setAccent(undefined);
    expect(loadSettings().accent).toBe("#123456");
    expect(changedServerUiPrefs(previous, loadSettings())).toBeNull();

    const reconnected = connected
      ? undefined
      : refreshProfileAppearancePrefs({
          ...options,
          client: createServerPrefsWriter(request, scope).state.client!,
        });
    delayed.resolve({
      status: "ok",
      entries: returnedAccent ? { "ui.accent": returnedAccent } : {},
    });
    await Promise.all([pending, reconnected]);
    expect(loadSettings().accent).toBe(returnedAccent ?? "#abcdef");
    expect(request.mock.calls.every(([method]) => method === "users.prefs.get")).toBe(true);
  },
);

it("resets the fontUi profile override when its picker sentinel is selected", async () => {
  const { context, props, previous } = await loadProfile({}, { "ui.fontUi": "lora" });
  props().setFontUi(undefined);
  expect(loadSettings().fontUi).toBeUndefined();
  expect(context.theme.settings.fontUi).toBeUndefined();
  expect(changedServerUiPrefs(previous, loadSettings())).toEqual({ fontUi: null });
});

it("uses the committed snapshot for both display and reset while the form draft differs", async () => {
  const committedConfig = { ui: { prefs: { theme: "claw" } } };
  const draftConfig = { ui: { prefs: { theme: "knot" } } };
  const runtimeConfig = {
    state: {
      connected: true,
      configSnapshot: { config: committedConfig },
      configSchema: { type: "object", properties: {} },
      configForm: draftConfig,
      configFormOriginal: committedConfig,
      configFormDirty: true,
    },
    patchForm: vi.fn(),
  };
  const context = configContext({
    gateway: {
      connection: { gatewayUrl: "ws://committed.test" },
      snapshot: {
        hello: { auth: auth() },
        phase: "connected",
      },
    },
    runtimeConfig,
    theme: { refresh: vi.fn() },
  });
  const beforeReset = loadSettings();
  const { container } = mountConfigPage(context, { pageId: "appearance" });

  const themeSection = await waitForSolid(() => {
    const section = container.querySelector<HTMLElement>("#settings-appearance-theme");
    expect(section?.textContent).toContain("Default: Claw");
    return section!;
  });
  expect(themeSection?.textContent).toContain("Synced across your devices");
  expect(themeSection?.textContent).not.toContain("Default: Knot");
  expect(themeSection?.textContent).not.toContain("Stored in this browser only");

  themeSection?.querySelector<HTMLButtonElement>(".settings-theme-card--claw")?.click();

  expect(changedServerUiPrefs(beforeReset, loadSettings())).toEqual({ theme: null });
});

it.each([
  ["microphone", "disconnect"],
  ["microphone", "reentry"],
  ["microphone", "reentry with gesture"],
  ["microphone", "passive failure"],
  ["microphone", "leave during retry"],
  ["microphone", "permission failure"],
  ["camera", "reentry with gesture"],
] as const)("%s permission lifetime: %s", async (kind, scenario) => {
  const initial = deferred<MediaDeviceInfo[]>();
  const second = deferred<MediaDeviceInfo[]>();
  const enumerateDevices = vi.fn().mockResolvedValue([]);
  const stop = vi.fn();
  const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
  const devices = Object.assign(new EventTarget(), { enumerateDevices, getUserMedia });
  vi.stubGlobal("navigator", { mediaDevices: devices });
  const page = mountConfigPageState(configContext(), { pageId: "appearance" });
  const props = page.state.configProps;
  await Promise.all([props().microphone?.discovery, props().camera?.discovery]);
  flush();
  enumerateDevices.mockReset().mockResolvedValue([]);
  const startsWithPermission = scenario === "permission failure";
  // devicechange refreshes both pickers; only this scenario's picker is delayed.
  if (!startsWithPermission && kind === "camera") {
    enumerateDevices.mockResolvedValueOnce([]);
  }
  enumerateDevices.mockReturnValueOnce(initial.promise);
  if (!startsWithPermission && kind === "microphone") {
    enumerateDevices.mockResolvedValueOnce([]);
  }
  if (scenario === "leave during retry") {
    enumerateDevices.mockReturnValueOnce(second.promise);
  }
  const refresh = () =>
    kind === "microphone" ? props().onMicrophoneRefresh?.() : props().onCameraRefresh?.();
  if (!startsWithPermission) {
    devices.dispatchEvent(new Event("devicechange"));
  }
  refresh();
  flush();
  const initialCalls = startsWithPermission ? 1 : 2;
  expect(enumerateDevices).toHaveBeenCalledTimes(initialCalls);
  expect(getUserMedia).not.toHaveBeenCalled();

  if (scenario === "disconnect") {
    page.dispose();
  } else if (scenario.startsWith("reentry")) {
    page.update({ pageId: "advanced" });
    page.update({ pageId: "appearance" });
    if (scenario === "reentry with gesture") {
      refresh();
    }
  }
  if (["passive failure", "leave during retry", "permission failure"].includes(scenario)) {
    initial.reject(new DOMException("Synthetic inactive enumeration", "InvalidStateError"));
  } else {
    initial.resolve([]);
  }
  if (scenario === "leave during retry") {
    await waitForSolid(() => expect(enumerateDevices).toHaveBeenCalledTimes(initialCalls + 1));
    page.update({ pageId: "advanced" });
    second.resolve([]);
  }
  if (scenario === "disconnect") {
    await initial.promise;
    await Promise.resolve();
    flush();
  } else {
    await props()[kind]?.discovery;
    flush();
  }
  const permits = ["reentry with gesture", "passive failure"].includes(scenario);
  expect(getUserMedia).toHaveBeenCalledTimes(permits ? 1 : 0);
  expect(stop).toHaveBeenCalledTimes(permits ? 1 : 0);
  if (permits) {
    expect(getUserMedia).toHaveBeenCalledWith(
      kind === "microphone" ? { audio: true } : { video: true },
    );
  }
  if (scenario === "permission failure") {
    expect(enumerateDevices).toHaveBeenCalledOnce();
    await expect(props()[kind]?.discovery).resolves.toBeTruthy();
  }
});
it("keeps media permission gestures live while discovery status is pending", async () => {
  const initial = deferred<MediaDeviceInfo[]>();
  const enumerateDevices = vi.fn().mockReturnValueOnce(initial.promise).mockResolvedValue([]);
  const stop = vi.fn();
  const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
  const mediaDevices = Object.assign(new EventTarget(), { enumerateDevices, getUserMedia });
  vi.stubGlobal("navigator", { mediaDevices });
  const { container } = mountConfigPage(configContext(), { pageId: "appearance" });
  const select = container.querySelector<HTMLSelectElement>("[data-settings-microphone]")!;
  expect(select).not.toBeNull();
  expect(select.disabled).toBe(false);
  expect(select.closest(".settings-row")?.textContent).not.toContain("No additional microphones");
  select.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  initial.resolve([]);
  await waitForSolid(() => expect(getUserMedia).toHaveBeenCalledWith({ audio: true }));
  expect(stop).toHaveBeenCalledOnce();
  await waitForSolid(() =>
    expect(select.closest(".settings-row")?.textContent).toContain("No additional microphones"),
  );
  enumerateDevices.mockRejectedValueOnce(new DOMException("Device unavailable", "NotFoundError"));
  mediaDevices.dispatchEvent(new Event("devicechange"));
  await waitForSolid(() =>
    expect(select.closest(".settings-row")?.querySelector('[role="alert"]')).not.toBeNull(),
  );
  expect(container.querySelector("[data-settings-microphone]")).toBe(select);
  select.focus();
  const retry = deferred<MediaDeviceInfo[]>();
  enumerateDevices.mockReturnValueOnce(retry.promise);
  mediaDevices.dispatchEvent(new Event("devicechange"));
  await waitForSolid(() =>
    expect(select.closest(".settings-row")?.querySelector('[role="alert"]')).toBeNull(),
  );
  expect(select.closest(".settings-row")?.textContent).not.toContain("No additional microphones");
  expect(document.activeElement).toBe(select);
  retry.resolve([
    {
      deviceId: "recovered-mic",
      groupId: "synthetic",
      kind: "audioinput",
      label: "Recovered microphone",
      toJSON: () => ({}),
    },
  ]);
  await waitForSolid(() => expect(select.textContent).toContain("Recovered microphone"));
  expect(container.querySelector("[data-settings-microphone]")).toBe(select);
  expect(document.activeElement).toBe(select);
});

it("persists only confirmed camera selections and ignores superseded failures", async () => {
  const first = deferred();
  switchActiveRealtimeTalkCameras
    .mockRejectedValueOnce(new Error("The selected camera is unavailable"))
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("Another camera error"))
    .mockResolvedValueOnce(undefined);
  const context = completeConfigContext(configContext());
  const theme = createApplicationTheme(
    loadSettings(context.gateway.connection.gatewayUrl),
    context.gateway,
  );
  Object.assign(context, { theme });
  onTestFinished(() => theme.dispose());
  const { state } = mountConfigPageState(context);
  const props = state.configProps;

  await expect(props().onCameraSelect?.("missing-camera")).rejects.toThrow(
    "The selected camera is unavailable",
  );
  expect(loadSettings().realtimeTalkVideoDeviceId).toBeUndefined();
  expect(theme.settings.realtimeTalkVideoDeviceId).toBeUndefined();

  const superseded = props().onCameraSelect?.("slow-camera");
  await props().onCameraSelect?.("back-camera");
  await expect(superseded).resolves.toBeUndefined();
  flush();
  expect(props().camera?.selectedDeviceId).toBe("back-camera");
  expect(loadSettings().realtimeTalkVideoDeviceId).toBe("back-camera");
  expect(theme.settings.realtimeTalkVideoDeviceId).toBe("back-camera");
  first.reject(new Error("The selected camera is unavailable"));
  await first.promise.catch(() => undefined);
  flush();
  await expect(props().camera?.selection).resolves.toBeUndefined();
  expect(loadSettings().realtimeTalkVideoDeviceId).toBe("back-camera");
  expect(theme.settings.realtimeTalkVideoDeviceId).toBe("back-camera");

  await expect(props().onCameraSelect?.("another-missing-camera")).rejects.toThrow(
    "Another camera error",
  );
  await props().onCameraSelect?.("");
  flush();
  expect(props().camera?.selectedDeviceId).toBe("");
  expect(loadSettings().realtimeTalkVideoDeviceId).toBeUndefined();
  expect(theme.settings.realtimeTalkVideoDeviceId).toBeUndefined();
});

it("keeps the camera select mounted through pending, rejected, and retried selections", async () => {
  const pending = deferred();
  const retry = deferred();
  const recovery = deferred();
  switchActiveRealtimeTalkCameras
    .mockReturnValueOnce(pending.promise)
    .mockReturnValueOnce(retry.promise)
    .mockReturnValueOnce(recovery.promise);
  stubCameraDevices();
  const { container } = mountConfigPage(configContext(), { pageId: "appearance" });
  const select = container.querySelector<HTMLSelectElement>("[data-settings-camera]")!;
  await waitForSolid(() => expect(select.options).toHaveLength(2));
  select.focus();
  select.value = "camera-1";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() => expect(select.value).toBe("camera-1"));
  expect(loadSettings().realtimeTalkVideoDeviceId).toBeUndefined();
  pending.reject(new Error("Synthetic camera unavailable"));
  const alert = () => select.closest(".settings-row")?.querySelector('[role="alert"]');
  await waitForSolid(() => expect(alert()?.textContent).toContain("Synthetic camera unavailable"));
  expect(select.value).toBe("");
  expect(container.querySelector("[data-settings-camera]")).toBe(select);
  expect(document.activeElement).toBe(select);
  select.value = "camera-1";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() => expect(alert()).toBeNull());
  retry.reject(new Error("Synthetic second camera failure"));
  await waitForSolid(() => expect(alert()?.textContent).toBe("Synthetic second camera failure"));
  expect(select.value).toBe("");
  expect(container.querySelector("[data-settings-camera]")).toBe(select);
  expect(document.activeElement).toBe(select);
  select.value = "camera-1";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() => expect(alert()).toBeNull());
  recovery.resolve();
  await waitForSolid(() => expect(loadSettings().realtimeTalkVideoDeviceId).toBe("camera-1"));
  expect(alert()).toBeNull();
  expect(select.value).toBe("camera-1");
  expect(container.querySelector("[data-settings-camera]")).toBe(select);
  expect(document.activeElement).toBe(select);
});

it("leaves Appearance while a camera selection is unresolved", async () => {
  const pending = deferred();
  switchActiveRealtimeTalkCameras.mockReturnValueOnce(pending.promise);
  stubCameraDevices();
  const view = mountConfigPage(configContext(), { pageId: "appearance" });
  const select = view.container.querySelector<HTMLSelectElement>("[data-settings-camera]")!;
  await waitForSolid(() => expect(select.options).toHaveLength(2));
  select.value = "camera-1";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() =>
    expect(switchActiveRealtimeTalkCameras).toHaveBeenCalledWith("camera-1"),
  );
  expect(loadSettings().realtimeTalkVideoDeviceId).toBeUndefined();

  view.update({ pageId: "notifications" });
  await waitForSolid(() => {
    expect(view.container.querySelector("h1")?.textContent).toBe("Notifications");
    expect(view.container.querySelector("[data-settings-camera]")).toBeNull();
  });

  pending.resolve();
  await waitForSolid(() => expect(loadSettings().realtimeTalkVideoDeviceId).toBe("camera-1"));
  expect(view.container.querySelector("h1")?.textContent).toBe("Notifications");
  expect(view.container.querySelector("[data-settings-camera]")).toBeNull();
});

it("leaves Talk while a native voice edit is unresolved and still accepts its outcome", async () => {
  const snapshot = createNativeDeviceSettingsSnapshot();
  const pending = Promise.withResolvers<unknown>();
  const post = vi
    .fn<(message: { type: string }) => Promise<unknown>>()
    .mockResolvedValue(undefined);
  vi.stubGlobal("webkit", { messageHandlers: { openclawDeviceSettings: { postMessage: post } } });
  vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
  const capability = createNativeDeviceSettingsCapability()!;
  const view = mountConfigPage(configContext({ nativeDeviceSettings: capability }), {
    pageId: "talk",
  });
  try {
    const wake = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    post.mockReturnValueOnce(pending.promise);
    wake.click();
    await waitForSolid(() => expect(view.container.textContent).toContain("Saving"));
    expect(capability.snapshot?.voice.wakeEnabled).toBe(false);

    view.update({ pageId: "notifications" });
    await waitForSolid(() => {
      expect(view.container.querySelector("h1")?.textContent).toBe("Notifications");
      expect(view.container.querySelector("openclaw-talk-settings")).toBeNull();
    });
    const accepted = structuredClone(snapshot);
    accepted.voice.wakeEnabled = true;
    pending.resolve(accepted);
    await waitForSolid(() => expect(capability.snapshot?.voice.wakeEnabled).toBe(true));
    expect(view.container.querySelector("h1")?.textContent).toBe("Notifications");
  } finally {
    capability.dispose();
  }
});

it("leaves the settings route before a camera switch settles and still records its outcome", async () => {
  const pending = deferred();
  switchActiveRealtimeTalkCameras.mockReturnValueOnce(pending.promise);
  stubCameraDevices();
  const appearance = pages.find((page) => page.id === "appearance");
  if (!appearance || appearance.id !== "appearance") {
    throw new Error("Missing Appearance route");
  }
  const production = await appearance.component();
  const module = {
    ...production,
    renderSolid: (props: SolidRouteProps<ConfigPageRouteData>) =>
      createComponent(provider.wrapper, {
        get children() {
          return createComponent(production.renderSolid, props);
        },
      }),
  };
  const usageModule = {
    renderSolid: () => {
      const destination = document.createElement("p");
      destination.textContent = "Usage destination";
      return destination;
    },
  };
  const router = createRouter<
    ConfigPageId | "usage",
    ApplicationContext,
    typeof module | typeof usageModule,
    ConfigPageRouteData
  >({
    routes: [
      { ...appearance, component: () => module },
      definePage({
        id: "usage",
        path: "/usage",
        component: () => usageModule,
      }),
    ],
  });
  const context = completeConfigContext(configContext({ router, theme: { refresh: vi.fn() } }));
  const provider = createSolidApplicationContextProvider(context);
  const outlet = mountRouterOutlet({ router, retryContext: context });
  try {
    await router.navigate("appearance", context);
    await waitForSolid(() =>
      expect(
        outlet.querySelector<HTMLSelectElement>("[data-settings-camera]")?.options,
      ).toHaveLength(2),
    );
    const select = outlet.querySelector<HTMLSelectElement>("[data-settings-camera]")!;
    select.value = "camera-1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForSolid(() =>
      expect(switchActiveRealtimeTalkCameras).toHaveBeenCalledWith("camera-1"),
    );
    expect(loadSettings().realtimeTalkVideoDeviceId).toBeUndefined();

    await router.navigate("usage", context);
    await waitForSolid(() => {
      expect(outlet.textContent).toContain("Usage destination");
      expect(outlet.querySelector("openclaw-config-page")).toBeNull();
    });
    expect(loadSettings().realtimeTalkVideoDeviceId).toBeUndefined();
    pending.resolve();
    await waitForSolid(() => expect(loadSettings().realtimeTalkVideoDeviceId).toBe("camera-1"));
    expect(outlet.textContent).toContain("Usage destination");
    expect(outlet.querySelector("openclaw-config-page")).toBeNull();
  } finally {
    pending.resolve();
    outlet.dispose();
    router.stop();
  }
});

it("updates mobile pairing eligibility when connection and admin access are published", () => {
  const openDevicePairSetup = vi.fn();
  const context = configContext({
    gateway: { snapshot: { phase: "disconnected", hello: null, client: null } },
    runtimeConfig: { state: { connected: false } },
    overlays: { openDevicePairSetup },
  });
  const view = mountConfigPage(context, { pageId: "security" });
  const pairingButton = view.container.querySelector<HTMLButtonElement>(
    ".security-page button.btn",
  )!;
  expect(pairingButton.disabled).toBe(true);

  context.runtimeConfig.state.connected = true;
  Object.assign(context.gateway.snapshot, {
    phase: "connected",
    hello: { auth: auth() },
  });
  publishConfigSource(context.runtimeConfig);
  expect(pairingButton.disabled).toBe(false);
  pairingButton.click();
  expect(openDevicePairSetup).toHaveBeenCalledOnce();

  Object.assign(context.gateway.snapshot, {
    hello: { auth: auth(["operator.read"]) },
  });
  publishConfigSource(context.gateway);
  expect(pairingButton.disabled).toBe(true);
  pairingButton.click();
  expect(openDevicePairSetup).toHaveBeenCalledOnce();

  Object.assign(context.gateway.snapshot, {
    hello: { auth: auth() },
  });
  publishConfigSource(context.gateway);
  expect(pairingButton.disabled).toBe(false);
  context.runtimeConfig.state.connected = false;
  publishConfigSource(context.runtimeConfig);
  expect(pairingButton.disabled).toBe(true);
});

it.each([
  ["read-only operator", ["operator.read"], true],
  ["config.set absent", ["operator.admin"], false],
] as const)("locks server-backed controls for %s", (_name, scopes, canSet) => {
  const context = configContext({
    runtimeConfig: { canSet, state: { connected: true } },
    gateway: { snapshot: { hello: { auth: auth([...scopes]) } } },
    overlays: { snapshot: { updateRunning: false, updateReconciliationPending: false } },
  });

  const { state } = mountConfigPageState(context);
  expect(state.mutationDisabled()).toBe(true);
});

it("refreshes update status once when the page becomes active", async () => {
  const refreshUpdateStatus = vi.fn(async () => {});
  const context = configContext({
    gateway: connectedGateway(["update.status"]),
    overlays: { refreshUpdateStatus },
  });

  const view = mountConfigPage(context, { pageId: "updates" });
  publishConfigSource(context.gateway);
  publishConfigSource(context.overlays);
  await waitForSolid(() => expect(refreshUpdateStatus).toHaveBeenCalledOnce());

  view.update({ pageId: "advanced" });
  view.update({ pageId: "updates" });
  await waitForSolid(() => expect(refreshUpdateStatus).toHaveBeenCalledTimes(2));
});

it("presents initial and manual update status reads without hiding policy controls", async () => {
  const initial = deferred<boolean>();
  const manual = deferred<boolean>();
  const refreshUpdateStatus = vi
    .fn<ApplicationContext["overlays"]["refreshUpdateStatus"]>()
    .mockReturnValueOnce(initial.promise)
    .mockReturnValueOnce(manual.promise);
  const context = configContext({
    gateway: connectedGateway(["update.status"]),
    overlays: {
      refreshUpdateStatus,
      snapshot: {
        updateStatusBanner: { source: "read", tone: "warn", text: "Recorded update status" },
      },
    },
  });
  const { container } = mountConfigPage(context, { pageId: "updates" });
  const status = () => container.querySelector(".settings-status")?.textContent;
  await waitForSolid(() => expect(status()).toContain("Checking for updates…"));
  expect(container.querySelectorAll('input[role="switch"]')).toHaveLength(2);
  expect(refreshUpdateStatus).toHaveBeenCalledOnce();

  initial.resolve(true);
  await waitForSolid(() => expect(status()).toContain("Recorded update status"));
  const check = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Check status",
  )!;
  check.click();
  await waitForSolid(() => expect(status()).toContain("Checking for updates…"));
  expect(check.disabled).toBe(true);
  manual.resolve(false);
  await waitForSolid(() => {
    expect(status()).toContain("Recorded update status");
    expect(check.disabled).toBe(false);
  });
  expect(container.querySelector(".updates-status-check-failed")).toBeNull();
  expect(refreshUpdateStatus).toHaveBeenCalledTimes(2);
});

it("retires an update status receipt when the page leaves and re-enters", async () => {
  const first = deferred<boolean>();
  const second = deferred<boolean>();
  const refreshUpdateStatus = vi
    .fn<ApplicationContext["overlays"]["refreshUpdateStatus"]>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const context = configContext({
    gateway: connectedGateway(["update.status"]),
    overlays: {
      refreshUpdateStatus,
      snapshot: { updateStatusBanner: { tone: "warn", text: "Current update status" } },
    },
  });
  const view = mountConfigPage(context, { pageId: "updates" });
  const status = () => view.container.querySelector(".settings-status")?.textContent;
  await waitForSolid(() => expect(status()).toContain("Checking for updates…"));
  view.update({ pageId: "advanced" });
  view.update({ pageId: "updates" });
  expect(refreshUpdateStatus).toHaveBeenCalledTimes(2);
  first.resolve(false);
  await waitForSolid(() => expect(status()).toContain("Checking for updates…"));
  second.resolve(true);
  await waitForSolid(() => expect(status()).toContain("Current update status"));
});

it("retries a rejected update status read without hiding policy controls", async () => {
  const failed = deferred<boolean>();
  const retried = deferred<boolean>();
  const refreshUpdateStatus = vi
    .fn<ApplicationContext["overlays"]["refreshUpdateStatus"]>()
    .mockReturnValueOnce(failed.promise)
    .mockReturnValueOnce(retried.promise);
  const context = configContext({
    gateway: connectedGateway(["update.status"]),
    overlays: {
      refreshUpdateStatus,
      snapshot: { updateStatusBanner: { tone: "warn", text: "Current update status" } },
    },
  });
  const { container } = mountConfigPage(context, { pageId: "updates" });
  await waitForSolid(() => expect(refreshUpdateStatus).toHaveBeenCalledOnce());
  failed.reject(new Error("Synthetic status read failed"));
  await waitForSolid(() =>
    expect(container.querySelector(".updates-status-check-failed")?.textContent).toContain(
      "Synthetic status read failed",
    ),
  );
  expect(container.querySelectorAll('input[role="switch"]')).toHaveLength(2);
  container.querySelector<HTMLButtonElement>(".updates-status-check-failed button")!.click();
  await waitForSolid(() => {
    expect(refreshUpdateStatus).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".settings-status")?.textContent).toContain(
      "Checking for updates…",
    );
  });
  retried.resolve(true);
  await waitForSolid(() => {
    expect(container.querySelector(".settings-status")?.textContent).toContain(
      "Current update status",
    );
    expect(container.querySelector(".updates-status-check-failed")).toBeNull();
  });
});

it("stages policy changes through patchForm and confirms Update Gateway… before overlays", async () => {
  const patchForm = vi.fn();
  const updateActions = {
    captureUpdateTarget: () => () => true,
    runUpdate: vi.fn<ApplicationContext["overlays"]["runUpdate"]>(),
  } satisfies Pick<ApplicationContext["overlays"], "captureUpdateTarget" | "runUpdate">;
  const { runUpdate } = updateActions;
  const context = configContext({
    runtimeConfig: {
      canSet: true,
      state: {
        connected: true,
        configForm: { update: { channel: "stable", auto: { enabled: false } } },
      },
      patchForm,
    },
    gateway: connectedGateway(["update.run"]),
    overlays: {
      snapshot: {
        updateSchedule: { channel: "stable", autoEnabled: false },
        updateRunning: false,
        updateReconciliationPending: false,
      },
      ...updateActions,
    },
  });
  const { container } = mountConfigPage(context, { pageId: "updates" });
  const restoreDialogPolyfill = installDialogPolyfill();
  const updateButton = () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Update Gateway…",
    )!;
  const status = () => container.querySelector(".settings-status")?.textContent;

  context.overlays.snapshot.updateStatusRefreshing = true;
  publishConfigSource(context.overlays);
  const checkingButton = updateButton();
  expect(checkingButton.textContent?.trim()).toBe("Update Gateway…");
  expect(checkingButton).toMatchObject({ disabled: true, title: "Checking for updates…" });
  expect(status()).toContain("Checking for updates…");
  expect(container.querySelector(".settings-segmented__input")?.hasAttribute("aria-disabled")).toBe(
    true,
  );
  context.overlays.snapshot.updateStatusRefreshing = false;
  context.overlays.snapshot.updateStatusCheckBanner = {
    mode: "manual",
    tone: "warn",
    text: "Could not check for updates: timeout",
  };
  publishConfigSource(context.overlays);
  expect(updateButton()).toMatchObject({
    disabled: true,
    title: "Check for updates successfully before starting an update.",
  });

  context.overlays.snapshot.updateSchedule = {
    channel: "dev",
    autoEnabled: false,
    install: { kind: "git", git: { status: "diverged", commitsAhead: 1, commitsBehind: 3 } },
  };
  publishConfigSource(context.overlays);
  expect(updateButton()).toMatchObject({ disabled: false, title: "" });
  expect(status()).toContain("Could not check for updates: timeout");
  expect(runUpdate).not.toHaveBeenCalled();

  container.querySelector<HTMLInputElement>('.settings-segmented__input[value="beta"]')!.click();
  const policySwitches = [
    ...container.querySelectorAll<HTMLInputElement>(".settings-toggle__input"),
  ];
  const togglePolicy = (title: string, checked: boolean) => {
    const control = policySwitches.find(
      (input) =>
        input
          .closest(".settings-row")
          ?.querySelector(".settings-row__title")
          ?.textContent?.trim() === title,
    );
    if (!control) {
      throw new Error(`Missing ${title} control`);
    }
    control.checked = checked;
    control.dispatchEvent(new Event("change"));
  };
  togglePolicy("Check for updates", false);
  togglePolicy("Automatic updates", true);
  updateButton().click();
  await nextFrame();

  expect(patchForm).toHaveBeenCalledWith(["update", "channel"], "beta");
  expect(patchForm).toHaveBeenCalledWith(["update", "checkOnStart"], false);
  expect(patchForm).toHaveBeenCalledWith(["update", "auto", "enabled"], true);
  expect(runUpdate).not.toHaveBeenCalled();

  const { modal } = await waitForRenderedModalDialog(document.body);
  [...modal.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Update and restart")
    ?.click();
  await nextFrame();

  expect(runUpdate).toHaveBeenCalledOnce();
  restoreDialogPolyfill();
});

function createRuntimeConfig() {
  const state = {
    configSnapshot: null,
    configLoading: false,
    configSchema: null,
    configSchemaLoading: false,
  };
  return {
    state,
    ensureLoaded: vi.fn(async () => {
      state.configLoading = true;
      await Promise.resolve();
      Object.assign(state, { configLoading: false, configSnapshot: { config: {} } });
    }),
    ensureSchemaLoaded: vi.fn(async () => {
      Object.assign(state, { configSchema: {} });
    }),
  };
}

it("loads Updates without requesting the admin-only config schema", async () => {
  const runtimeConfig = createRuntimeConfig();

  mountConfigPageState(configContext({ runtimeConfig }), { pageId: "updates" });
  // SAFETY: mounting flushes owner setup and starts ensureLoaded before returning.
  await runtimeConfig.ensureLoaded.mock.results[0]!.value;
  await Promise.resolve();

  expect(runtimeConfig.ensureLoaded).toHaveBeenCalledOnce();
  expect(runtimeConfig.ensureSchemaLoaded).not.toHaveBeenCalled();
});

it("loads replacement sources and clears sensitive reveal state", async () => {
  const first = createRuntimeConfig();
  const second = createRuntimeConfig();

  const context = configContext({ runtimeConfig: first });
  const { state } = mountConfigPageState(context);
  await waitForSolid(() => expect(first.ensureSchemaLoaded).toHaveBeenCalledOnce());
  const viewState = state.configProps().viewState;
  Object.assign(viewState, { rawRevealed: true, envRevealed: true });
  viewState.revealedSensitivePaths.add("gateway.auth.token");
  state.configProps().onViewStateChange();
  flush();
  Object.assign(context, { runtimeConfig: second });
  publishConfigSource(context.gateway);
  await waitForSolid(() => expect(second.ensureSchemaLoaded).toHaveBeenCalledOnce());

  for (const source of [first, second]) {
    expect(source.ensureLoaded).toHaveBeenCalledOnce();
    expect(source.ensureSchemaLoaded).toHaveBeenCalledOnce();
  }
  expect(state.configProps().viewState).toMatchObject({
    rawRevealed: false,
    envRevealed: false,
  });
  expect(state.configProps().viewState.revealedSensitivePaths.size).toBe(0);
});
