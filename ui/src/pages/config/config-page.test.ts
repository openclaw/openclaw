/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
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

let localStorageMock: Storage;

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  vi.spyOn(realtimeTalk, "switchActiveRealtimeTalkCameras").mockImplementation(
    switchActiveRealtimeTalkCameras,
  );
  localStorageMock = createStorageMock();
  vi.stubGlobal("localStorage", localStorageMock);
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

describe("extractQuickSettingsSecurity", () => {
  it("distinguishes explicit values that equal the defaults", () => {
    expect(
      extractQuickSettingsSecurity({
        browser: { enabled: true },
        tools: { profile: "full" },
      }),
    ).toMatchObject({
      browserEnabled: true,
      browserEnabledOverridden: true,
      toolProfile: "full",
      toolProfileOverridden: true,
    });
  });
});

describe("ConfigPage synced preference provenance", () => {
  it.each([
    {
      label: "lets a profile-bound operator write appearance without config admin access",
      selfUser: { id: "profile-owner" },
      scopes: ["operator.write"],
      canPatch: false,
      appearanceCanSync: true,
      localeCanSync: false,
    },
    {
      label: "keeps read-only profile appearance device-local even when config patching is exposed",
      selfUser: { id: "profile-viewer" },
      scopes: ["operator.read"],
      canPatch: true,
      appearanceCanSync: false,
      localeCanSync: true,
    },
    {
      label: "preserves config-patch authorization when no profile is bound",
      selfUser: null,
      scopes: ["operator.write"],
      canPatch: false,
      appearanceCanSync: false,
      localeCanSync: false,
    },
  ])("$label", ({ selfUser, scopes, canPatch, appearanceCanSync, localeCanSync }) => {
    const context = {
      gateway: {
        snapshot: { selfUser, hello: { auth: { role: "operator", scopes } } },
      },
      runtimeConfig: { state: { connected: true }, canPatch },
    } as unknown as ApplicationContext;

    expect(canSyncAppearancePreference(context, "theme")).toBe(appearanceCanSync);
    expect(canSyncAppearancePreference(context, "themeMode")).toBe(appearanceCanSync);
    expect(canSyncAppearancePreference(context, "accent")).toBe(appearanceCanSync);
    expect(canSyncAppearancePreference(context, "fontUi")).toBe(
      Boolean(selfUser) && appearanceCanSync,
    );
    expect(canSyncAppearancePreference(context, "fontChat")).toBe(
      Boolean(selfUser) && appearanceCanSync,
    );
    expect(canSyncAppearancePreference(context, "tabIcon")).toBe(
      Boolean(selfUser) && appearanceCanSync,
    );
    expect(canSyncAppearancePreference(context)).toBe(localeCanSync);
  });

  it("restores the gateway appearance default while queuing deletion of the profile override", async () => {
    const configObject = { ui: { prefs: { theme: "dash" } } };
    const client = {
      request: vi.fn(async () => ({ status: "ok", entries: { "ui.theme": "knot" } })),
    } as unknown as GatewayBrowserClient;
    await refreshProfileAppearancePrefs({
      client,
      profileId: "profile-owner",
      configObject,
      scope: "ws://profile.test",
      onApplied: vi.fn(),
    });
    const context = {
      gateway: {
        connection: { gatewayUrl: "ws://profile.test" },
        snapshot: {
          selfUser: { id: "profile-owner" },
          hello: { auth: { role: "operator", scopes: ["operator.write"] } },
        },
      },
      runtimeConfig: {
        state: { connected: true, configSnapshot: { config: configObject } },
        canPatch: false,
      },
      theme: { refresh: vi.fn() },
    } as unknown as ApplicationContext;
    const beforeReset = loadSettings();
    const { state } = mountConfigPageState(context);

    state.configProps().setTheme("dash");

    expect(loadSettings().theme).toBe("dash");
    expect(changedServerUiPrefs(beforeReset, loadSettings())).toEqual({
      theme: null,
      accent: "theme",
      fontUi: null,
      fontChat: null,
    });
  });

  it.each([
    ["loading", undefined, true],
    ["disconnected", undefined, true],
    ["before-load-disconnect", "#55bb77", true],
  ] as const)(
    "reconciles the returned accent after a %s reset with server value %s (edited: %s)",
    async (connection, returnedAccent, edited) => {
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
      if (edited) {
        patchSettings({ accent: "#654321" });
        pushServerUiPrefs(initial, { accent: "#654321" }, { profileId, canWrite: false });
      }

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
      const context = {
        gateway: {
          connection: { gatewayUrl: scope },
          snapshot: {
            selfUser: connected ? { id: profileId } : null,
            hello: { auth: { role: "operator", scopes: ["operator.read"] } },
          },
        },
        runtimeConfig: {
          state: { connected, configSnapshot: connected ? { config: configObject } : null },
          canPatch: false,
        },
        theme: { refresh: vi.fn() },
      } as unknown as ApplicationContext;
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

  it.each(["fontUi"] as const)(
    "resets the %s profile override when its picker sentinel is selected",
    async (key) => {
      const gatewayUrl = "ws://font-profile.test";
      const configObject = {};
      const client = {
        request: vi.fn(async () => ({ status: "ok", entries: { [`ui.${key}`]: "lora" } })),
      } as unknown as GatewayBrowserClient;
      await refreshProfileAppearancePrefs({
        client,
        profileId: "font-owner",
        configObject,
        scope: gatewayUrl,
        onApplied: vi.fn(),
      });
      const context = {
        gateway: {
          connection: { gatewayUrl },
          snapshot: {
            selfUser: { id: "font-owner" },
            hello: { auth: { role: "operator", scopes: ["operator.write"] } },
          },
        },
        runtimeConfig: {
          state: { connected: true, configSnapshot: { config: configObject } },
          canPatch: false,
        },
        theme: { refresh: vi.fn() },
      } as unknown as ApplicationContext;
      const previous = loadSettings();
      const { state } = mountConfigPageState(context);
      state.configProps().setFontUi(undefined);
      expect(loadSettings()[key]).toBeUndefined();
      expect(changedServerUiPrefs(previous, loadSettings())).toEqual({ [key]: null });
      expect(context.theme.refresh).toHaveBeenCalledOnce();
    },
  );

  it("uses the committed snapshot for both display and reset while the form draft differs", async () => {
    const committedConfig = { ui: { prefs: { theme: "claw" } } };
    const draftConfig = { ui: { prefs: { theme: "knot" } } };
    const runtimeConfig = {
      state: {
        client: null,
        connected: true,
        configLoading: false,
        configRaw: JSON.stringify(draftConfig),
        configRawOriginal: JSON.stringify(committedConfig),
        configValid: true,
        configIssues: [],
        configSaving: false,
        configApplying: false,
        configNeedsApply: false,
        configSnapshot: {
          config: committedConfig,
          hash: "committed-hash",
          issues: [],
          raw: JSON.stringify(committedConfig),
          runtimeConfig: {},
          valid: true,
        },
        configSchema: { type: "object", properties: {} },
        configSchemaLoading: false,
        configUiHints: {},
        configForm: draftConfig,
        configFormOriginal: committedConfig,
        configFormDirty: true,
        configFormMode: "form",
      },
      patchForm: vi.fn(),
      removeFormValue: vi.fn(),
      setRaw: vi.fn(),
      save: vi.fn(),
      discardDraft: vi.fn(),
      openFile: vi.fn(),
    } as unknown as ApplicationContext["runtimeConfig"];
    const context = {
      basePath: "",
      config: {
        current: {
          assistantIdentity: { name: "OpenClaw" },
          serverVersion: "2026.7.1",
        },
      },
      gateway: {
        connection: { gatewayUrl: "ws://committed.test" },
        snapshot: {
          hello: { auth: { role: "operator", scopes: ["operator.admin"] } },
          phase: "connected",
        },
      },
      navigate: vi.fn(),
      overlays: {
        snapshot: {
          updateReconciliationPending: false,
          updateRunning: false,
        },
      },
      runtimeConfig,
      agentSelection: { state: { selectedId: null } },
      agents: { state: { agentsList: null } },
      theme: { branding: resolveThemeBranding(undefined), refresh: vi.fn() },
      webPush: { snapshot: {} },
    } as unknown as ApplicationContext;
    const beforeReset = loadSettings();
    const { container } = mountConfigPage(context, { pageId: "appearance" });
    flush();

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
});

describe("media permission lifetime: Settings", () => {
  it.each([
    ["microphone", "queued gesture disconnects"],
    ["microphone", "reentry without a fresh gesture"],
    ["microphone", "reentry with a fresh gesture"],
    ["microphone", "failed passive enumeration keeps one upgrade"],
    ["microphone", "second enumeration leaves Appearance"],
    ["microphone", "permission-bearing enumeration fails once"],
    ["camera", "reentry with a fresh gesture"],
  ] as const)("%s: %s", async (kind, scenario) => {
    const initial = deferred<MediaDeviceInfo[]>();
    const second = deferred<MediaDeviceInfo[]>();
    const enumerateDevices = vi.fn().mockResolvedValue([]);
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    const devices = Object.assign(new EventTarget(), { enumerateDevices, getUserMedia });
    vi.stubGlobal("navigator", { mediaDevices: devices });
    // SAFETY: completeConfigContext supplies the unused capabilities for this fixture.
    const context = {
      gateway: { snapshot: { phase: "disconnected" } },
    } as unknown as ApplicationContext;
    const page = mountConfigPageState(context, { pageId: "appearance" });
    const props = page.state.configProps;
    await waitForSolid(() => {
      expect(props().microphone?.loading).toBe(false);
      expect(props().camera?.loading).toBe(false);
    });
    enumerateDevices.mockReset().mockResolvedValue([]);
    const startsWithPermission = scenario.startsWith("permission-bearing");
    // devicechange refreshes both pickers; only this scenario's picker is delayed.
    if (!startsWithPermission && kind === "camera") {
      enumerateDevices.mockResolvedValueOnce([]);
    }
    enumerateDevices.mockReturnValueOnce(initial.promise);
    if (!startsWithPermission && kind === "microphone") {
      enumerateDevices.mockResolvedValueOnce([]);
    }
    if (scenario === "second enumeration leaves Appearance") {
      enumerateDevices.mockReturnValueOnce(second.promise);
    }
    const refresh = () =>
      kind === "microphone" ? props().onMicrophoneRefresh?.() : props().onCameraRefresh?.();
    if (startsWithPermission) {
      refresh();
    } else {
      devices.dispatchEvent(new Event("devicechange"));
      refresh();
    }
    const initialCalls = startsWithPermission ? 1 : 2;
    expect(enumerateDevices).toHaveBeenCalledTimes(initialCalls);
    expect(getUserMedia).not.toHaveBeenCalled();

    if (scenario === "queued gesture disconnects") {
      page.dispose();
    } else if (scenario.startsWith("reentry")) {
      page.update({ pageId: "advanced" });
      page.update({ pageId: "appearance" });
      if (scenario === "reentry with a fresh gesture") {
        refresh();
      }
    }
    if (
      scenario === "failed passive enumeration keeps one upgrade" ||
      scenario === "second enumeration leaves Appearance" ||
      scenario === "permission-bearing enumeration fails once"
    ) {
      initial.reject(new DOMException("Synthetic inactive enumeration", "InvalidStateError"));
    } else {
      initial.resolve([]);
    }
    if (scenario === "second enumeration leaves Appearance") {
      await waitForSolid(() => expect(enumerateDevices).toHaveBeenCalledTimes(initialCalls + 1));
      page.update({ pageId: "advanced" });
      second.resolve([]);
    }
    if (scenario === "queued gesture disconnects") {
      await initial.promise;
      await Promise.resolve();
      flush();
    } else {
      await waitForSolid(() => expect(props()[kind]?.loading).toBe(false));
    }
    const permits = [
      "reentry with a fresh gesture",
      "failed passive enumeration keeps one upgrade",
    ].includes(scenario);
    expect(getUserMedia).toHaveBeenCalledTimes(permits ? 1 : 0);
    expect(stop).toHaveBeenCalledTimes(permits ? 1 : 0);
    if (permits) {
      expect(getUserMedia).toHaveBeenCalledWith(
        kind === "microphone" ? { audio: true } : { video: true },
      );
    }
    if (scenario === "permission-bearing enumeration fails once") {
      expect(enumerateDevices).toHaveBeenCalledOnce();
      expect(props()[kind]?.error).toBeTruthy();
    }
  });
});

describe("ConfigPage camera selection", () => {
  it("persists only confirmed camera selections and ignores superseded failures", async () => {
    const first = deferred();
    switchActiveRealtimeTalkCameras
      .mockRejectedValueOnce(new Error("The selected camera is unavailable"))
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Another camera error"))
      .mockResolvedValueOnce(undefined);
    // SAFETY: completeConfigContext supplies the unused capabilities for this fixture.
    const context = {
      gateway: { snapshot: { phase: "disconnected" } },
      theme: { refresh: vi.fn() },
    } as unknown as ApplicationContext;
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
});

describe("ConfigPage curated mutation eligibility", () => {
  it("updates mobile pairing eligibility when connection and admin access are published", () => {
    const openDevicePairSetup = vi.fn();
    const context = {
      gateway: { snapshot: { phase: "disconnected", hello: null, client: null } },
      runtimeConfig: { state: { connected: false } },
      overlays: { openDevicePairSetup },
    } as unknown as ApplicationContext;
    const view = mountConfigPage(context, { pageId: "security" });
    const pairingButton = view.container.querySelector<HTMLButtonElement>(
      ".security-page button.btn",
    )!;
    expect(pairingButton.disabled).toBe(true);

    context.runtimeConfig.state.connected = true;
    Object.assign(context.gateway.snapshot, {
      phase: "connected",
      hello: { auth: { role: "operator", scopes: ["operator.admin"] } },
    });
    publishConfigSource(context.runtimeConfig);
    expect(pairingButton.disabled).toBe(false);
    pairingButton.click();
    expect(openDevicePairSetup).toHaveBeenCalledOnce();

    Object.assign(context.gateway.snapshot, {
      hello: { auth: { role: "operator", scopes: ["operator.read"] } },
    });
    publishConfigSource(context.gateway);
    expect(pairingButton.disabled).toBe(true);
    pairingButton.click();
    expect(openDevicePairSetup).toHaveBeenCalledOnce();

    Object.assign(context.gateway.snapshot, {
      hello: { auth: { role: "operator", scopes: ["operator.admin"] } },
    });
    publishConfigSource(context.gateway);
    expect(pairingButton.disabled).toBe(false);
    context.runtimeConfig.state.connected = false;
    publishConfigSource(context.runtimeConfig);
    expect(pairingButton.disabled).toBe(true);
  });

  it.each([
    ["read-only operator", { connected: true }, ["operator.read"], false, true],
    ["config.set absent", { connected: true }, ["operator.admin"], false, false],
  ])("locks server-backed controls for %s", (_name, statePatch, scopes, updateRunning, canSet) => {
    const context = {
      runtimeConfig: {
        canSet,
        state: {
          configLoading: false,
          configSaving: false,
          configApplying: false,
          ...statePatch,
        },
      },
      gateway: {
        snapshot: { hello: { auth: { role: "operator", scopes } } },
      },
      overlays: {
        snapshot: { updateRunning, updateReconciliationPending: false },
      },
    } as unknown as ApplicationContext;

    const { state } = mountConfigPageState(context);
    expect(state.mutationDisabled()).toBe(true);
  });
});

describe("ConfigPage Updates integration", () => {
  it("refreshes update status once when the page becomes active", async () => {
    const refreshUpdateStatus = vi.fn(async () => {});
    const context = {
      gateway: {
        snapshot: {
          client: {},
          phase: "connected",
          hello: {
            auth: { role: "operator", scopes: ["operator.admin"] },
            features: { methods: ["update.status"] },
          },
        },
      },
      overlays: { refreshUpdateStatus },
    } as unknown as ApplicationContext;

    const view = mountConfigPage(context, { pageId: "updates" });
    flush();
    publishConfigSource(context.gateway);
    publishConfigSource(context.overlays);
    await waitForSolid(() => expect(refreshUpdateStatus).toHaveBeenCalledOnce());

    view.update({ pageId: "advanced" });
    flush();
    view.update({ pageId: "updates" });
    flush();
    await waitForSolid(() => expect(refreshUpdateStatus).toHaveBeenCalledTimes(2));
  });

  it("stages policy changes through patchForm and confirms Update now before overlays", async () => {
    const patchForm = vi.fn();
    const updateActions = {
      captureUpdateTarget: () => () => true,
      runUpdate: vi.fn<ApplicationContext["overlays"]["runUpdate"]>(),
    } satisfies Pick<ApplicationContext["overlays"], "captureUpdateTarget" | "runUpdate">;
    const { runUpdate } = updateActions;
    const context = {
      config: {
        current: { assistantIdentity: { name: "OpenClaw" }, serverVersion: "2026.8.1" },
      },
      runtimeConfig: {
        canSet: true,
        state: {
          connected: true,
          configLoading: false,
          configSaving: false,
          configApplying: false,
          configForm: { update: { channel: "stable", auto: { enabled: false } } },
          configSnapshot: null,
        },
        patchForm,
      },
      gateway: {
        snapshot: {
          client: {},
          phase: "connected",
          hello: {
            auth: { role: "operator", scopes: ["operator.admin"] },
            features: { methods: ["update.run"] },
          },
        },
        // The update dialog watches both stores for the life of the install.
        subscribe: () => () => undefined,
      },
      overlays: {
        snapshot: {
          updateAvailable: null,
          updateSchedule: { channel: "stable", autoEnabled: false },
          updateRunning: false,
          updateReconciliationPending: false,
          updateStatusBanner: null,
        },
        subscribe: () => () => undefined,
        ...updateActions,
      },
    } as unknown as ApplicationContext;
    const view = mountConfigPage(context, { pageId: "updates" });
    const { container } = view;
    const restoreDialogPolyfill = installDialogPolyfill();

    context.overlays.snapshot.updateStatusRefreshing = true;
    publishConfigSource(context.overlays);
    flush();
    const checkingButton = container.querySelector<HTMLButtonElement>(".btn.primary")!;
    expect(checkingButton.textContent?.trim()).toBe("Update now");
    expect(checkingButton.disabled).toBe(true);
    expect(checkingButton.title).toBe("Checking for updates…");
    expect(container.querySelector(".settings-status")?.textContent).toContain(
      "Checking for updates…",
    );
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
    flush();
    const unknownUpdateButton = container.querySelector<HTMLButtonElement>(".btn.primary")!;
    expect(unknownUpdateButton.disabled).toBe(true);
    expect(unknownUpdateButton.title).toBe(
      "Check for updates successfully before starting an update.",
    );

    context.overlays.snapshot.updateSchedule = {
      channel: "dev",
      autoEnabled: false,
      install: { kind: "git", git: { status: "diverged", commitsAhead: 1, commitsBehind: 3 } },
    };
    publishConfigSource(context.overlays);
    flush();
    const knownUpdateButton = container.querySelector<HTMLButtonElement>(".btn.primary")!;
    expect(knownUpdateButton.disabled).toBe(false);
    expect(knownUpdateButton.title).toBe("");
    expect(container.querySelector(".settings-status")?.textContent).toContain(
      "Could not check for updates: timeout",
    );
    expect(runUpdate).not.toHaveBeenCalled();

    const channel = container.querySelector<HTMLInputElement>(
      '.settings-segmented__input[value="beta"]',
    );
    if (!channel) {
      throw new Error("Missing update channel control");
    }
    channel.click();
    const policySwitches = [
      ...container.querySelectorAll<HTMLInputElement>(".settings-toggle__input"),
    ];
    const checks = policySwitches.find(
      (control) =>
        control
          .closest(".settings-row")
          ?.querySelector(".settings-row__title")
          ?.textContent?.trim() === "Check for updates",
    );
    if (!checks) {
      throw new Error("Missing update checks control");
    }
    checks.checked = false;
    checks.dispatchEvent(new Event("change"));
    const automatic = policySwitches.find(
      (control) =>
        control
          .closest(".settings-row")
          ?.querySelector(".settings-row__title")
          ?.textContent?.trim() === "Automatic updates",
    );
    if (!automatic) {
      throw new Error("Missing automatic update control");
    }
    automatic.checked = true;
    automatic.dispatchEvent(new Event("change"));
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Update now"))
      ?.click();
    await nextFrame();

    expect(patchForm).toHaveBeenCalledWith(["update", "channel"], "beta");
    expect(patchForm).toHaveBeenCalledWith(["update", "checkOnStart"], false);
    expect(patchForm).toHaveBeenCalledWith(["update", "auto", "enabled"], true);
    // Settings shares the sidebar card's confirmation gate: nothing runs on the click itself.
    expect(runUpdate).not.toHaveBeenCalled();

    const { modal } = await waitForRenderedModalDialog(document.body);
    [...modal.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Update and restart")
      ?.click();
    await nextFrame();

    expect(runUpdate).toHaveBeenCalledOnce();
    restoreDialogPolyfill();
    container.remove();
  });
});

describe("ConfigPage runtime config lifecycle", () => {
  function createRuntimeConfig() {
    const state = {
      configSnapshot: null,
      configLoading: false,
      configSchema: null,
      configSchemaLoading: false,
    };
    const runtimeConfig = {
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
    return runtimeConfig;
  }

  it("loads Updates without requesting the admin-only config schema", async () => {
    const runtimeConfig = createRuntimeConfig();

    // SAFETY: completeConfigContext supplies the unused capabilities for this fixture.
    const context = {
      gateway: { snapshot: { phase: "disconnected" } },
      runtimeConfig,
    } as unknown as ApplicationContext;
    mountConfigPageState(context, { pageId: "updates" });
    // SAFETY: mounting flushes owner setup and starts ensureLoaded before returning.
    await runtimeConfig.ensureLoaded.mock.results[0]!.value;
    await Promise.resolve();

    expect(runtimeConfig.ensureLoaded).toHaveBeenCalledOnce();
    expect(runtimeConfig.ensureSchemaLoaded).not.toHaveBeenCalled();
  });

  it("loads replacement sources and clears sensitive reveal state", async () => {
    const first = createRuntimeConfig();
    const second = createRuntimeConfig();

    // SAFETY: completeConfigContext supplies the unused capabilities for this fixture.
    const context = {
      gateway: { snapshot: { phase: "disconnected" } },
      runtimeConfig: first,
    } as unknown as ApplicationContext;
    const { state } = mountConfigPageState(context);
    await waitForSolid(() => expect(first.ensureSchemaLoaded).toHaveBeenCalledOnce());
    const viewState = state.configProps().viewState;
    viewState.rawRevealed = true;
    viewState.envRevealed = true;
    viewState.revealedSensitivePaths.add("gateway.auth.token");
    state.configProps().onViewStateChange();
    flush();
    Object.assign(context, { runtimeConfig: second });
    publishConfigSource(context.gateway);
    await waitForSolid(() => expect(second.ensureSchemaLoaded).toHaveBeenCalledOnce());

    expect(first.ensureLoaded).toHaveBeenCalledOnce();
    expect(first.ensureSchemaLoaded).toHaveBeenCalledOnce();
    expect(second.ensureLoaded).toHaveBeenCalledOnce();
    expect(second.ensureSchemaLoaded).toHaveBeenCalledOnce();
    expect(state.configProps().viewState.rawRevealed).toBe(false);
    expect(state.configProps().viewState.envRevealed).toBe(false);
    expect(state.configProps().viewState.revealedSensitivePaths.size).toBe(0);
  });
});
