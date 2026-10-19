/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
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
import {
  installDialogPolyfill,
  nextFrame,
  waitForRenderedModalDialog,
} from "../../test-helpers/modal-dialog.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import * as realtimeTalk from "../chat/talk/session.ts";
import { extractQuickSettingsSecurity } from "./config-page-state.ts";
import {
  mountConfigPage,
  mountConfigPageState,
  publishConfigSource,
} from "./config-page.test-support.ts";

const switchActiveRealtimeTalkCameras =
  vi.fn<typeof realtimeTalk.switchActiveRealtimeTalkCameras>();

// Mount helpers fill capabilities unrelated to each scenario.
function configContext(overrides: object = {}) {
  return {
    gateway: { snapshot: { phase: "disconnected" } },
    ...overrides,
  } as unknown as ApplicationContext;
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
  await refreshProfileAppearancePrefs({
    configObject,
    scope,
    profileId,
    onApplied: vi.fn(),
    client,
  });
  const context = profileContext(scope, profileId, configObject);
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
  const { props, previous } = await loadProfile(configObject, { "ui.theme": "knot" });
  props().setTheme("dash");

  expect(loadSettings().theme).toBe("dash");
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
  expect(changedServerUiPrefs(previous, loadSettings())).toEqual({ fontUi: null });
  expect(context.theme.refresh).toHaveBeenCalledOnce();
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
  await waitForSolid(() => {
    expect(props()).toMatchObject({ microphone: { loading: false }, camera: { loading: false } });
  });
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
    await waitForSolid(() => expect(props()[kind]?.loading).toBe(false));
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
    expect(props()[kind]?.error).toBeTruthy();
  }
});
it("persists only confirmed camera selections and ignores superseded failures", async () => {
  const first = deferred();
  switchActiveRealtimeTalkCameras
    .mockRejectedValueOnce(new Error("The selected camera is unavailable"))
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("Another camera error"))
    .mockResolvedValueOnce(undefined);
  const context = configContext({ theme: { refresh: vi.fn() } });
  const { state } = mountConfigPageState(context);
  const props = state.configProps;

  props().onCameraSelect?.("missing-camera");
  await waitForSolid(() =>
    expect(props().camera?.error).toBe("The selected camera is unavailable"),
  );
  expect(loadSettings().realtimeTalkVideoDeviceId).toBeUndefined();
  expect(context.theme.refresh).not.toHaveBeenCalled();

  props().onCameraSelect?.("slow-camera");
  flush();
  expect(props().camera?.error).toBeNull();
  props().onCameraSelect?.("back-camera");
  await waitForSolid(() => expect(props().camera?.selectedDeviceId).toBe("back-camera"));
  expect(loadSettings().realtimeTalkVideoDeviceId).toBe("back-camera");
  expect(context.theme.refresh).toHaveBeenCalledOnce();
  first.reject(new Error("The selected camera is unavailable"));
  await first.promise.catch(() => undefined);
  flush();
  expect(props().camera?.error).toBeNull();
  expect(loadSettings().realtimeTalkVideoDeviceId).toBe("back-camera");
  expect(context.theme.refresh).toHaveBeenCalledOnce();

  props().onCameraSelect?.("another-missing-camera");
  await waitForSolid(() => expect(props().camera?.error).toBe("Another camera error"));
  props().onCameraSelect?.("");
  await waitForSolid(() => expect(props().camera?.selectedDeviceId).toBe(""));
  expect(props().camera?.error).toBeNull();
  expect(loadSettings().realtimeTalkVideoDeviceId).toBeUndefined();
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

it("stages policy changes through patchForm and confirms Update now before overlays", async () => {
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
  const updateButton = () => container.querySelector<HTMLButtonElement>(".btn.primary")!;
  const status = () => container.querySelector(".settings-status")?.textContent;

  context.overlays.snapshot.updateStatusRefreshing = true;
  publishConfigSource(context.overlays);
  const checkingButton = updateButton();
  expect(checkingButton.textContent?.trim()).toBe("Update now");
  expect(checkingButton).toMatchObject({ disabled: true, title: "Checking for updates…" });
  expect(status()).toContain("Checking for updates…");
  expect(container.querySelector<HTMLInputElement>(".settings-segmented__input")?.disabled).toBe(
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
