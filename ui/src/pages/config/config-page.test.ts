/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { changedServerUiPrefs } from "../../app/server-prefs-intent.ts";
import { createServerPrefsWriter } from "../../app/server-prefs.test-support.ts";
import {
  applyServerUiPrefs,
  flushServerUiPrefs,
  pushServerUiPrefs,
  refreshProfileAppearancePrefs,
  resetServerUiPrefsSync,
} from "../../app/server-prefs.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import {
  installDialogPolyfill,
  nextFrame,
  waitForRenderedModalDialog,
} from "../../test-helpers/modal-dialog.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import * as realtimeTalk from "../chat/talk/session.ts";
import { ConfigPage, extractQuickSettingsSecurity } from "./config-page.ts";
import { serverUiPrefProvenanceHint } from "./view-appearance-preferences.ts";
import type { ConfigViewState } from "./view.ts";

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
  resetServerUiPrefsSync();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("extractQuickSettingsSecurity", () => {
  it("preserves provenance for inherited security defaults", () => {
    expect(extractQuickSettingsSecurity({})).toMatchObject({
      browserEnabled: true,
      browserEnabledOverridden: false,
      toolProfile: "",
      toolProfileOverridden: false,
    });
  });

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
    const page = new ConfigPage() as unknown as {
      context: ApplicationContext;
      serverUiPrefsCanSync: (
        key?: "theme" | "themeMode" | "accent" | "fontUi" | "fontChat",
      ) => boolean | null;
    };
    page.context = {
      gateway: {
        snapshot: { selfUser, hello: { auth: { role: "operator", scopes } } },
      },
      runtimeConfig: { state: { connected: true }, canPatch },
    } as unknown as ApplicationContext;

    expect(page.serverUiPrefsCanSync("theme")).toBe(appearanceCanSync);
    expect(page.serverUiPrefsCanSync("themeMode")).toBe(appearanceCanSync);
    expect(page.serverUiPrefsCanSync("accent")).toBe(appearanceCanSync);
    expect(page.serverUiPrefsCanSync("fontUi")).toBe(Boolean(selfUser) && appearanceCanSync);
    expect(page.serverUiPrefsCanSync("fontChat")).toBe(Boolean(selfUser) && appearanceCanSync);
    expect(page.serverUiPrefsCanSync()).toBe(localeCanSync);
  });

  it("describes profile-owned appearance without changing gateway or device-local hints", () => {
    expect(serverUiPrefProvenanceHint("profile")).toBe(
      "Saved to your profile — follows you on every device.",
    );
    expect(serverUiPrefProvenanceHint("synced")).toBe(
      "Synced across your devices through the gateway.",
    );
    expect(serverUiPrefProvenanceHint("device-local")).toBe("Stored in this browser only.");
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
    const page = new ConfigPage() as unknown as {
      context: ApplicationContext;
      settings: ReturnType<typeof loadSettings>;
      resetSyncedAppearancePref: (key: "theme") => void;
    };
    page.context = {
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
    page.settings = beforeReset;

    page.resetSyncedAppearancePref("theme");

    expect(page.settings.theme).toBe("dash");
    expect(changedServerUiPrefs(beforeReset, page.settings)).toEqual({
      theme: null,
      accent: "theme",
      fontUi: null,
      fontChat: null,
    });
  });

  it.each([
    ["loading", "#123456", true],
    ["loading", "#55bb77", true],
    ["loading", undefined, true],
    ["disconnected", "#123456", true],
    ["disconnected", "#55bb77", true],
    ["disconnected", undefined, true],
    ["before-load-disconnect", "#55bb77", true],
    ["before-load-disconnect", "#123456", true],
    ["disconnected", "#123456", false],
    ["disconnected", "#55bb77", false],
    ["before-load-disconnect", undefined, false],
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
      const page = new ConfigPage() as unknown as {
        context: ApplicationContext;
        settings: ReturnType<typeof loadSettings>;
        resetSyncedAppearancePref: (key: "accent") => void;
      };
      page.context = {
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
      page.settings = previous;
      page.resetSyncedAppearancePref("accent");
      expect(page.settings.accent).toBe("#123456");
      expect(changedServerUiPrefs(previous, page.settings)).toBeNull();

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

  it.each(["fontUi", "fontChat"] as const)(
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
      const page = new ConfigPage() as unknown as {
        context: ApplicationContext;
        settings: ReturnType<typeof loadSettings>;
        setFont: (key: "fontUi" | "fontChat", font: undefined) => void;
      };
      page.context = {
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
      page.settings = previous;
      page.setFont(key, undefined);
      expect(page.settings[key]).toBeUndefined();
      expect(changedServerUiPrefs(previous, page.settings)).toEqual({ [key]: null });
      expect(page.context.theme.refresh).toHaveBeenCalledOnce();
    },
  );

  it("uses the committed snapshot for both display and reset while the form draft differs", () => {
    const page = new ConfigPage();
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
      theme: { refresh: vi.fn() },
      webPush: { snapshot: {} },
    } as unknown as ApplicationContext;
    const state = page as unknown as {
      context: ApplicationContext;
      pageId: "appearance";
      settings: ReturnType<typeof loadSettings>;
    };
    state.context = context;
    state.pageId = "appearance";
    const beforeReset = loadSettings();
    const container = document.createElement("div");

    render(page.render(), container);

    const themeSection = container.querySelector<HTMLElement>("#settings-appearance-theme");
    expect(themeSection?.textContent).toContain("Default: Claw");
    expect(themeSection?.textContent).toContain("Synced across your devices");
    expect(themeSection?.textContent).not.toContain("Default: Knot");
    expect(themeSection?.textContent).not.toContain("Stored in this browser only");

    themeSection?.querySelector<HTMLButtonElement>(".settings-theme-card--claw")?.click();

    expect(changedServerUiPrefs(beforeReset, state.settings)).toEqual({ theme: null });
  });
});

describe("ConfigPage header", () => {
  it("renders the route subtitle for Communications", () => {
    const page = new ConfigPage();
    const state = page as unknown as {
      context: ApplicationContext;
      pageId: "communications";
      renderAdvancedConfig: () => undefined;
    };
    state.context = { runtimeConfig: { state: {} } } as unknown as ApplicationContext;
    state.pageId = "communications";
    state.renderAdvancedConfig = () => undefined;
    const container = document.createElement("div");

    render(page.render(), container);

    expect(container.querySelector(".page-subtitle")?.textContent?.trim()).toBe(
      "Messages, text-to-speech, and meeting capture settings.",
    );
  });
});

describe("ConfigPage media discovery", () => {
  it("coalesces refreshes while discovery is in flight", async () => {
    for (const method of ["refreshMicrophones", "refreshCameras"] as const) {
      const discovery = deferred<MediaDeviceInfo[]>();
      const enumerateDevices = vi.fn(() => discovery.promise);
      vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices } });
      const page = new ConfigPage();
      const state = page as unknown as Record<
        typeof method,
        (requestPermission: boolean) => Promise<void>
      >;

      const first = state[method](true);
      await state[method](true);
      expect(enumerateDevices).toHaveBeenCalledOnce();

      discovery.resolve([]);
      await first;
    }
  });
});

// The same matrix runs on the unchanged owner before applying the repair.
// Observe the real discovery callee at the MediaDevices boundary, not queue flags.
describe("media permission lifetime: Settings", () => {
  const scenarios = [
    "queued gesture remains active",
    "queued gesture leaves Appearance",
    "queued gesture disconnects",
    "permission-bearing enumeration leaves Appearance",
    "reentry without a fresh gesture",
    "reentry with a fresh gesture",
    "failed passive enumeration keeps one upgrade",
    "second enumeration leaves Appearance",
    "permission-bearing enumeration fails once",
  ] as const;

  for (const kind of ["microphone", "camera"] as const) {
    it.each(scenarios)(`${kind}: %s`, async (scenario) => {
      const initial = deferred<MediaDeviceInfo[]>();
      const second = deferred<MediaDeviceInfo[]>();
      const enumerateDevices = vi.fn().mockReturnValueOnce(initial.promise);
      if (scenario === "second enumeration leaves Appearance") {
        enumerateDevices.mockReturnValueOnce(second.promise);
      }
      enumerateDevices.mockResolvedValue([]);
      const stop = vi.fn();
      const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
      vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices, getUserMedia } });
      const page = new ConfigPage();
      page.pageId = "appearance";
      const state = page as unknown as {
        refreshMicrophones: (requestPermission: boolean) => Promise<void>;
        refreshCameras: (requestPermission: boolean) => Promise<void>;
        microphoneLoading: boolean;
        cameraLoading: boolean;
        microphoneError: string | null;
        cameraError: string | null;
      };
      const refresh = (requestPermission: boolean) =>
        kind === "microphone"
          ? state.refreshMicrophones(requestPermission)
          : state.refreshCameras(requestPermission);
      const leaveAppearance = () => {
        page.pageId = "advanced";
        page.willUpdate(new Map([["pageId", "appearance"]]));
      };
      const startsWithPermission = scenario.startsWith("permission-bearing");
      const first = refresh(startsWithPermission);
      if (!startsWithPermission) {
        await refresh(true);
      }
      expect(enumerateDevices).toHaveBeenCalledOnce();
      expect(getUserMedia).not.toHaveBeenCalled();

      if (scenario === "queued gesture disconnects") {
        page.disconnectedCallback();
      } else if (
        scenario === "queued gesture leaves Appearance" ||
        scenario === "permission-bearing enumeration leaves Appearance" ||
        scenario.startsWith("reentry")
      ) {
        leaveAppearance();
      }
      if (scenario.startsWith("reentry")) {
        page.pageId = "appearance";
        page.willUpdate(new Map([["pageId", "advanced"]]));
        await refresh(scenario === "reentry with a fresh gesture");
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
        await vi.waitFor(() => expect(enumerateDevices).toHaveBeenCalledTimes(2));
        leaveAppearance();
        second.resolve([]);
      }
      await first;
      await vi.waitFor(() =>
        expect(kind === "microphone" ? state.microphoneLoading : state.cameraLoading).toBe(false),
      );
      const permits = [
        "queued gesture remains active",
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
        expect(kind === "microphone" ? state.microphoneError : state.cameraError).toBeTruthy();
      }
    });
  }
});

describe("ConfigPage camera selection", () => {
  it("persists only confirmed camera selections and ignores superseded failures", async () => {
    let rejectFirst: (error: Error) => void = () => undefined;
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    switchActiveRealtimeTalkCameras
      .mockRejectedValueOnce(new Error("The selected camera is unavailable"))
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const page = new ConfigPage();
    const state = page as unknown as {
      cameraError: string | null;
      selectCamera: (deviceId: string) => Promise<void>;
      applySettings: ReturnType<typeof vi.fn>;
    };
    state.applySettings = vi.fn();

    await state.selectCamera("missing-camera");
    expect(state.cameraError).toBe("The selected camera is unavailable");
    expect(state.applySettings).not.toHaveBeenCalled();

    const staleSelection = state.selectCamera("slow-camera");
    expect(state.cameraError).toBeNull();
    await state.selectCamera("back-camera");
    expect(state.applySettings).toHaveBeenCalledOnce();
    expect(state.applySettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ realtimeTalkVideoDeviceId: "back-camera" }),
    );
    rejectFirst(new Error("The selected camera is unavailable"));
    await staleSelection;
    expect(state.cameraError).toBeNull();
    expect(state.applySettings).toHaveBeenCalledOnce();

    state.cameraError = "Another camera error";
    await state.selectCamera("");
    expect(state.cameraError).toBeNull();
    expect(state.applySettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ realtimeTalkVideoDeviceId: undefined }),
    );
  });
});

describe("ConfigPage curated mutation eligibility", () => {
  it.each([
    ["offline", { connected: false }, ["operator.admin"], false, true],
    ["read-only operator", { connected: true }, ["operator.read"], false, true],
    ["config.set absent", { connected: true }, ["operator.admin"], false, false],
    ["config save", { connected: true, configSaving: true }, ["operator.admin"], false, true],
    ["app update", { connected: true }, ["operator.admin"], true, true],
    ["idle administrator", { connected: true }, ["operator.admin"], false, true],
  ])("locks server-backed controls for %s", (_name, statePatch, scopes, updateRunning, canSet) => {
    const page = new ConfigPage();
    const state = page as unknown as {
      context: ApplicationContext;
      isCuratedConfigMutationDisabled: () => boolean;
    };
    state.context = {
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

    const expectedUnlocked = _name === "idle administrator";
    expect(state.isCuratedConfigMutationDisabled()).toBe(!expectedUnlocked);
  });
});

describe("ConfigPage Updates integration", () => {
  it("refreshes update status once when the page becomes active", () => {
    const refreshUpdateStatus = vi.fn(async () => {});
    const page = new ConfigPage();
    const state = page as unknown as {
      context: ApplicationContext;
      syncUpdateStatusRefresh: () => void;
    };
    state.context = {
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

    page.pageId = "updates";
    state.syncUpdateStatusRefresh();
    state.syncUpdateStatusRefresh();
    expect(refreshUpdateStatus).toHaveBeenCalledOnce();

    page.pageId = "advanced";
    state.syncUpdateStatusRefresh();
    page.pageId = "updates";
    state.syncUpdateStatusRefresh();
    expect(refreshUpdateStatus).toHaveBeenCalledTimes(2);
  });

  it("stages policy changes through patchForm and confirms Update now before overlays", async () => {
    const patchForm = vi.fn();
    const runUpdate = vi.fn();
    const page = new ConfigPage();
    const state = page as unknown as { context: ApplicationContext };
    page.pageId = "updates";
    state.context = {
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
        runUpdate,
      },
    } as unknown as ApplicationContext;
    const container = document.createElement("div");
    document.body.append(container);
    const restoreDialogPolyfill = installDialogPolyfill();

    state.context.overlays.snapshot.updateStatusRefreshing = true;
    render(page.render(), container);
    const checkingButton = container.querySelector<HTMLButtonElement>(".btn.primary")!;
    expect(checkingButton.textContent?.trim()).toBe("Update now");
    expect(checkingButton.disabled).toBe(true);
    expect(checkingButton.title).toBe("Checking for updates…");
    expect(container.querySelector(".settings-status")?.textContent).toContain(
      "Checking for updates…",
    );
    expect(container.querySelector("wa-radio-group")?.hasAttribute("disabled")).toBe(true);
    state.context.overlays.snapshot.updateStatusRefreshing = false;
    state.context.overlays.snapshot.updateStatusCheckBanner = {
      mode: "manual",
      tone: "warn",
      text: "Could not check for updates: timeout",
    };
    render(page.render(), container);
    const unknownUpdateButton = container.querySelector<HTMLButtonElement>(".btn.primary")!;
    expect(unknownUpdateButton.disabled).toBe(true);
    expect(unknownUpdateButton.title).toBe(
      "Check for updates successfully before starting an update.",
    );

    state.context.overlays.snapshot.updateSchedule = {
      channel: "dev",
      autoEnabled: false,
      install: { kind: "git", git: { status: "diverged", commitsAhead: 1, commitsBehind: 3 } },
    };
    render(page.render(), container);
    const knownUpdateButton = container.querySelector<HTMLButtonElement>(".btn.primary")!;
    expect(knownUpdateButton.disabled).toBe(false);
    expect(knownUpdateButton.title).toBe("");
    expect(container.querySelector(".settings-status")?.textContent).toContain(
      "Could not check for updates: timeout",
    );
    expect(runUpdate).not.toHaveBeenCalled();

    const channel = container.querySelector<HTMLElement & { value: string }>("wa-radio-group");
    if (!channel) {
      throw new Error("Missing update channel control");
    }
    channel.value = "beta";
    channel.dispatchEvent(new Event("change"));
    const policySwitches = [
      ...container.querySelectorAll<HTMLElement & { checked: boolean }>("wa-switch"),
    ];
    const checks = policySwitches.find(
      (control) => control.textContent?.trim() === "Check for updates",
    );
    if (!checks) {
      throw new Error("Missing update checks control");
    }
    checks.checked = false;
    checks.dispatchEvent(new Event("change"));
    const automatic = policySwitches.find(
      (control) => control.textContent?.trim() === "Automatic updates",
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
  it("loads Updates without requesting the admin-only config schema", async () => {
    const page = new ConfigPage();
    page.pageId = "updates";
    const state = page as unknown as {
      synchronizeRuntimeConfig: (runtimeConfig: ApplicationContext["runtimeConfig"]) => void;
    };
    const runtimeConfig = {
      state: {
        configSnapshot: null,
        configLoading: false,
        configSchema: null,
        configSchemaLoading: false,
      },
      ensureLoaded: vi.fn(() => Promise.resolve()),
      ensureSchemaLoaded: vi.fn(() => Promise.resolve()),
    } as unknown as ApplicationContext["runtimeConfig"];

    state.synchronizeRuntimeConfig(runtimeConfig);
    await Promise.resolve();

    expect(runtimeConfig.ensureLoaded).toHaveBeenCalledOnce();
    expect(runtimeConfig.ensureSchemaLoaded).not.toHaveBeenCalled();
  });

  it("loads replacement sources and clears sensitive reveal state", async () => {
    const page = new ConfigPage();
    const state = page as unknown as {
      configViewState: ConfigViewState;
      synchronizeRuntimeConfig: (runtimeConfig: ApplicationContext["runtimeConfig"]) => void;
    };
    const createRuntimeConfig = () =>
      ({
        state: {
          configSnapshot: null,
          configLoading: false,
          configSchema: null,
          configSchemaLoading: false,
        },
        ensureLoaded: vi.fn(() => Promise.resolve()),
        ensureSchemaLoaded: vi.fn(() => Promise.resolve()),
      }) as unknown as ApplicationContext["runtimeConfig"];
    const first = createRuntimeConfig();
    const second = createRuntimeConfig();

    state.synchronizeRuntimeConfig(first);
    await Promise.resolve();
    state.configViewState.rawRevealed = true;
    state.configViewState.envRevealed = true;
    state.configViewState.revealedSensitivePaths.add("gateway.auth.token");
    state.synchronizeRuntimeConfig(second);
    await Promise.resolve();

    expect(first.ensureLoaded).toHaveBeenCalledOnce();
    expect(first.ensureSchemaLoaded).toHaveBeenCalledOnce();
    expect(second.ensureLoaded).toHaveBeenCalledOnce();
    expect(second.ensureSchemaLoaded).toHaveBeenCalledOnce();
    expect(state.configViewState.rawRevealed).toBe(false);
    expect(state.configViewState.envRevealed).toBe(false);
    expect(state.configViewState.revealedSensitivePaths.size).toBe(0);
  });
});
