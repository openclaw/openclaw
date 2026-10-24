/* @vitest-environment jsdom */
import { render } from "@solidjs/testing-library";
import { spread } from "@solidjs/web";
import { createComponent, createRoot, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult, GatewayAgentRow } from "../api/types.ts";
import {
  COMMAND_PALETTE_OPEN_EVENT,
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
} from "../components/command-palette-contract.ts";
import {
  TERMINAL_PANEL_TOGGLE_EVENT,
  PLUGIN_PANEL_TOGGLE_EVENT,
  UI_COMMAND_EVENT,
} from "../components/panel-toggle-contract.ts";
import { i18n } from "../i18n/index.ts";
import { SESSION_FACE_PREFERENCE_PARAM } from "../lib/sessions/route-navigation.ts";
import { createSessionCapabilityHarness } from "../lib/sessions/session-capability.test-support.ts";
import { showToast } from "../lib/toast.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { afterModalHidden, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { selectShellRouteState } from "./app-host-route-state.ts";
import {
  connectShellEvents,
  createShellOwner,
  mountShellView,
  settleShell,
} from "./app-host-solid.test-support.ts";
import {
  committedRouterState,
  createRosterRefreshContext,
  resetAppHostTestGlobals,
} from "./app-host.test-support.ts";
import { OpenClawShell, ShellOwner } from "./app-host.tsx";
import { SHELL_COMPONENT_TAGS } from "./app-shell-components.ts";
import { ShellGatewayOwner, type ShellGatewayHost } from "./app-shell-gateway.ts";
import type { ShellNavigationOwner } from "./app-shell-navigation.ts";
import { createApplicationNavigationPreferences } from "./bootstrap-navigation-preferences.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import { createChatSubmissions } from "./chat-submissions.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "./context.ts";
import {
  persistLazyShellAction,
  readLazyShellAction,
  SHELL_APPROVALS_OPEN_EVENT,
} from "./lazy-shell-action.ts";
import { shouldMergeChatChrome } from "./mobile-nav-layout.ts";
import { resolveOnboardingMode } from "./onboarding-mode.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings } from "./settings.ts";
import { scheduleStaleChunkReload } from "./stale-chunk-reload.ts";

// mock-isolation: shell lifecycle tests exercise palette admission without its application data owners.
vi.mock("../components/command-palette.tsx", () => ({
  CommandPalette: (
    props: Parameters<(typeof import("../components/command-palette.tsx"))["CommandPalette"]>[0],
  ) => {
    const element = Object.assign(document.createElement("openclaw-command-palette"), {
      isOpen: false,
      openPalette: vi.fn(),
      togglePalette: vi.fn(),
    });
    spread(element, () => ({ ref: props.ref }), true);
    return element;
  },
}));

vi.mock("./stale-chunk-reload.ts", async () => {
  const actual =
    await vi.importActual<typeof import("./stale-chunk-reload.ts")>("./stale-chunk-reload.ts");
  return {
    ...actual,
    scheduleStaleChunkReload: vi.fn(async () => true),
  };
});

function createRouteSessions() {
  const { sessions } = createSessionCapabilityHarness(vi.fn());
  onTestFinished(() => sessions.dispose());
  return sessions;
}

type TestShell = Omit<ShellOwner, "runtime"> & {
  runtime: { context: ApplicationContext };
  shellGateway: ShellGatewayOwner;
  shellNavigation: ShellNavigationOwner;
  handleGatewayEvent: (event: { event: string; payload: unknown }) => void;
};

function testShell(context?: unknown): TestShell {
  const shell = createShellOwner() as unknown as TestShell;
  if (context) {
    shell.runtime = { context: context as ApplicationContext };
  }
  return shell;
}

type I18nRecoveryWiring = {
  localeLoadRecovery?: {
    isUnrecoverableError: (error: unknown) => boolean;
    onUnrecoverableLocaleLoad?: (locale: string) => void;
  };
};

function roster(defaultId: string, agents: GatewayAgentRow[]): AgentsListResult {
  return { defaultId, mainKey: "main", scope: "per-sender", agents };
}

function createDragEvent(type: "dragover" | "drop", types: string[]) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  const dataTransfer = { dropEffect: "copy", types };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return { dataTransfer, event };
}

function mountPalette(shell: TestShell, openPalette: () => void) {
  const element = Object.assign(document.createElement(SHELL_COMPONENT_TAGS.palette), {
    custodianAvailable: false,
    desktopAvailable: false,
    isOpen: false,
    openPalette,
    togglePalette: vi.fn(),
  });
  shell.elements.commandPalette = element;
  shell.element.append(element);
}
function configurePaletteShell(openPalette: () => void, mounted = true): TestShell {
  const shell = testShell();
  Object.defineProperty(shell, "updateComplete", {
    configurable: true,
    get: () => Promise.resolve(true),
  });
  document.body.append(shell.element);
  onTestFinished(() => shell.element.remove());
  if (mounted) {
    mountPalette(shell, openPalette);
  }
  return shell;
}

async function withConnectedShell(shell: TestShell, run: () => void | Promise<void>) {
  shell.connect();
  try {
    await run();
  } finally {
    shell.disconnect();
  }
}

afterEach(resetAppHostTestGlobals);

describe("OpenClaw shell context lifecycle", () => {
  setupSidebarTest();

  it("restores a modal toast to a late-mounted shell after its navigation drawer closes", async () => {
    await import("../components/modal-dialog.tsx");
    vi.stubGlobal("requestIdleCallback", vi.fn());
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    const restoreDialog = installDialogPolyfill();
    const runtime = bootstrapApplication();
    const shell = createShellOwner();
    shell.runtime = runtime;
    document.body.append(shell.element);
    const view = mountShellView(shell);
    let modal: HTMLElementTagNameMap["openclaw-modal-dialog"] | undefined;
    try {
      await settleShell(shell);
      expect(shell.routeState).toEqual({});
      expect(shell.shellElement).toBeInstanceOf(HTMLElement);
      expect(shell.shellElement?.isConnected).toBe(false);
      expect(shell.navDrawerElement).toBeInstanceOf(HTMLElement);

      shell.connect();
      shell.routeState = { routeId: "about" };
      await settleShell(shell);
      const trigger = document.createElement("button");
      shell.shellElement!.append(trigger);
      shell.toggleNavigationSurface(trigger);
      await settleShell(shell);
      const toast = shell.toastElement as HTMLElementTagNameMap["openclaw-toast-host"];
      expect(toast.parentElement).toBe(shell.navDrawerElement);
      expect(showToast({ message: "Drawer result", durationMs: 60_000 })).toBe(true);
      await toast.updateComplete;
      await vi.dynamicImportSettled();
      flush();

      modal = document.createElement("openclaw-modal-dialog");
      document.body.append(modal);
      await modal.updateComplete;
      expect(showToast({ message: "Modal result", durationMs: 60_000 })).toBe(true);
      await toast.updateComplete;
      expect(toast.parentElement).toBe(modal.getOverlayContainer());

      shell.closeNavDrawer();
      await settleShell(shell);
      expect(shell.navDrawerOpen).toBe(false);
      expect(shell.navDrawerElement?.getAttribute("aria-modal")).toBeNull();
      const hidden = afterModalHidden(modal);
      modal.hide();
      await modal.updateComplete;
      await hidden;
      await Promise.resolve();
      flush();

      expect(toast.parentElement).toBe(shell.shellElement);
      expect(toast.textContent).toContain("Modal result");
    } finally {
      view.unmount();
      shell.disconnect();
      shell.element.remove();
      modal?.remove();
      runtime.stop();
      restoreDialog();
    }
  });

  it("preserves reload intent on disconnect but clears it on context replacement", async () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("requestIdleCallback", vi.fn());
    persistLazyShellAction({ eventType: COMMAND_PALETTE_OPEN_EVENT });
    const disconnected = createShellOwner();
    disconnected.disconnect();
    expect(readLazyShellAction()).toEqual({ eventType: COMMAND_PALETTE_OPEN_EVENT });

    const first = bootstrapApplication();
    const second = bootstrapApplication();
    const [runtime, setRuntime] = createSignal(first);
    let currentShell: ShellOwner | undefined;
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(() =>
        createComponent(OpenClawShell, {
          get runtime() {
            return runtime();
          },
          onShell(shell) {
            currentShell = shell instanceof ShellOwner ? shell : undefined;
          },
        }),
      );
      flush();
      expect(readLazyShellAction()).toEqual({ eventType: COMMAND_PALETTE_OPEN_EVENT });
      expect(currentShell?.isShellComponentRequested("palette")).toBe(true);
      const firstShell = currentShell;
      setRuntime(second);
      flush();
      expect(readLazyShellAction()).toBeNull();
      expect(currentShell).toBeDefined();
      expect(currentShell).not.toBe(firstShell);
      expect(currentShell?.pendingShellAction).toBeNull();
    } finally {
      view?.unmount();
      first.stop();
      second.stop();
    }
  });
});

describe("OpenClaw shell source initialization", () => {
  it("delegates repeated locale import failures to guarded stale-chunk recovery", () => {
    const scheduleReload = vi.mocked(scheduleStaleChunkReload);
    scheduleReload.mockClear();
    const recovery = (i18n as unknown as I18nRecoveryWiring).localeLoadRecovery;

    expect(
      recovery?.isUnrecoverableError(
        new Error("Failed to fetch dynamically imported module: /assets/fr-abc123.js"),
      ),
    ).toBe(true);
    recovery?.onUnrecoverableLocaleLoad?.("fr");

    expect(scheduleReload).toHaveBeenCalledOnce();
  });

  it("retries a pending locale once when the Gateway becomes connected", () => {
    const retryPendingLocale = vi.spyOn(i18n, "retryPendingLocale").mockImplementation(() => {});
    // Owner-direct: the shared jsdom lane can retain a sibling graph's
    // openclaw-app-shell class bound to a different i18n instance; constructing
    // the owner keeps the spy and the callee in the current module graph.
    const host = {
      activeSessionKey: "",
      context: undefined,
      lastLocalePrefSignature: null,
      outboxStoreImport: { load: vi.fn(async () => undefined) },
      shellNavigation: { recoverDeletedActiveSession: vi.fn() },
      routeState: {},
    } as unknown as ShellGatewayHost;
    const owner = new ShellGatewayOwner(host);
    const reconnecting = {
      client: null,
      phase: "reconnecting",
      sessionKey: "",
    } as ApplicationGatewaySnapshot;
    const connected = {
      client: {} as GatewayBrowserClient,
      phase: "connected",
      sessionKey: "",
    } as ApplicationGatewaySnapshot;

    owner.synchronizeGateway(reconnecting);
    owner.synchronizeGateway(connected);
    owner.synchronizeGateway({ ...connected });
    owner.synchronizeGateway({ ...connected });

    expect(retryPendingLocale).toHaveBeenCalledOnce();
    retryPendingLocale.mockRestore();
  });

  it("clears retained presentation when its context epoch ends", () => {
    const shell = testShell();
    const trigger = document.createElement("button");
    shell.navDrawerOpen = true;
    shell.navDrawerTrigger = trigger;
    shell.lastWorkspaceLocation = {
      routeId: "usage",
      pathname: "/usage",
      search: "?agent=old",
      hash: "",
    };
    shell.activeSessionKey = "agent:old:main";
    shell.commandPaletteTarget = { owner: trigger, onSlashCommand: vi.fn() };
    shell.settingsPreloadTimers.set(
      trigger,
      globalThis.setTimeout(() => undefined, 60_000),
    );

    shell.disconnect();

    expect(shell).toMatchObject({
      navDrawerOpen: false,
      navDrawerTrigger: null,
      lastWorkspaceLocation: null,
      activeSessionKey: "",
      commandPaletteTarget: undefined,
    });
    expect(shell.settingsPreloadTimers.size).toBe(0);
  });

  it("initializes replacement capabilities even when the Gateway client is unchanged", () => {
    const shell = testShell();
    shell.routeState = { routeId: "usage" };
    const client = {} as GatewayBrowserClient;
    const snapshot = { client, phase: "connected" } as ApplicationGatewaySnapshot;
    const createAgents = () =>
      ({
        state: { agentsList: null },
        ensureList: vi.fn(() => Promise.resolve(null)),
      }) as unknown as ApplicationContext["agents"];
    const createRuntimeConfig = () =>
      ({
        state: { client, connected: true },
        ensureLoaded: vi.fn(() => Promise.resolve()),
      }) as unknown as ApplicationContext["runtimeConfig"];
    const firstAgents = createAgents();
    const secondAgents = createAgents();
    const firstRuntimeConfig = createRuntimeConfig();
    const secondRuntimeConfig = createRuntimeConfig();

    shell.ensureAgentsList(snapshot, firstAgents);
    shell.ensureAgentsList(snapshot, firstAgents);
    shell.ensureAgentsList(snapshot, secondAgents);
    void shell.shellGateway.ensureRuntimeConfig(snapshot, firstRuntimeConfig);
    void shell.shellGateway.ensureRuntimeConfig(snapshot, firstRuntimeConfig);
    void shell.shellGateway.ensureRuntimeConfig(snapshot, secondRuntimeConfig);

    expect(firstAgents.ensureList).toHaveBeenCalledOnce();
    expect(secondAgents.ensureList).toHaveBeenCalledOnce();
    expect(firstRuntimeConfig.ensureLoaded).toHaveBeenCalledOnce();
    expect(secondRuntimeConfig.ensureLoaded).toHaveBeenCalledOnce();

    shell.disconnect();
    shell.ensureAgentsList(snapshot, secondAgents);
    void shell.shellGateway.ensureRuntimeConfig(snapshot, secondRuntimeConfig);

    expect(secondAgents.ensureList).toHaveBeenCalledTimes(2);
    expect(secondRuntimeConfig.ensureLoaded).toHaveBeenCalledTimes(2);
  });
});

describe("OpenClaw shell route session commits", () => {
  it("settles shell commits after the invalidating caller is disposed", async () => {
    const runtime = bootstrapApplication();
    onTestFinished(() => runtime.stop());
    const shell = createShellOwner();
    shell.runtime = runtime;
    const view = mountShellView(shell);
    flush();

    let disposeCaller!: () => void;
    createRoot((dispose) => {
      disposeCaller = dispose;
      shell.invalidate();
    });
    const commit = shell.updateComplete;
    shell.invalidate();
    expect(shell.updateComplete).toBe(commit);
    disposeCaller();
    flush();
    await expect(commit).resolves.toBe(true);

    shell.invalidate();
    const retiredCommit = shell.updateComplete;
    view.unmount();
    flush();
    await expect(retiredCommit).resolves.toBe(false);
  });

  it("preserves catalog identity when routing a slash-command draft", () => {
    const navigate = vi.fn();
    const shell = testShell({
      basePath: "",
      agents: { state: { agentsList: { defaultId: "research", mainKey: "main" } } },
      agentSelection: { state: { selectedId: "research" } },
      gateway: { snapshot: { hello: null } },
      sessions: createRouteSessions(),
      chatSubmissions: createChatSubmissions(),
      navigate,
    });
    shell.activeSessionKey = "catalog:claude:gateway%3Alocal:thread-1";
    shell.routeState = { routeId: "chat" };

    shell.handleCommandPaletteSlashCommand("/review");

    expect(navigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/research",
      search: "?catalog=claude&host=gateway%3Alocal&thread=thread-1&draft=%2Freview+",
    });
  });

  it("defers an unscoped not-found fallback until agent defaults are connected", () => {
    const replace = vi.fn();
    const snapshot = { phase: "connecting", hello: null };
    const shell = testShell({
      basePath: "",
      agents: {
        state: { agentsList: { defaultId: "research", mainKey: "workspace" } },
      },
      agentSelection: { set: vi.fn(), state: { selectedId: null } },
      gateway: { setSessionKey: vi.fn(), snapshot },
      sessions: createRouteSessions(),
      chatSubmissions: createChatSubmissions(),
      placementStartup: { get: vi.fn(() => null) },
      replace,
    });
    shell.activeSessionKey = "main";
    shell.routeState = { routeId: "chat" };

    expect(shell.shellNavigation.recoverNotFoundRoute()).toBe(false);
    expect(replace).not.toHaveBeenCalled();

    snapshot.phase = "connected";
    expect(shell.shellNavigation.recoverNotFoundRoute()).toBe(true);
    expect(replace).toHaveBeenCalledWith("chat", { pathname: "/chat/research" });
  });

  it("adopts a resolved chat session after path navigation from Cron", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const calls: string[] = [];
    const setAgent = vi.fn((agentId: string | null) => calls.push(`agent:${agentId}`));
    const setSessionKey = vi.fn((sessionKey: string) => calls.push(`session:${sessionKey}`));
    const shell = testShell({
      gateway: {
        snapshot: { phase: "stopped", client: null, sessionKey: "agent:main:session-a" },
        setSessionKey,
      },
      agentSelection: { set: setAgent },
      sessions: createRouteSessions(),
      chatSubmissions: createChatSubmissions(),
    });
    shell.activeSessionKey = "agent:main:session-a";
    shell.didConsiderNativeRouteRestore = true;

    shell.shellNavigation.updateRouteState(
      selectShellRouteState(committedRouterState("cron", "/cron")),
    );
    shell.shellNavigation.updateRouteState(
      selectShellRouteState(
        committedRouterState("chat", "/chat/main/session-b-12345678", {
          kind: "session",
          sessionKey: "agent:main:session-b",
        }),
      ),
    );

    expect(shell.activeSessionKey).toBe("agent:main:session-b");
    expect(setSessionKey).toHaveBeenCalledExactlyOnceWith("agent:main:session-b");
    expect(calls).toEqual(["agent:main", "session:agent:main:session-b"]);
  });

  it("retains the custodian leave transition through an unresolved route state", () => {
    const shell = testShell();

    shell.shellNavigation.updateRouteState({ routeId: "custodian" });
    shell.shellNavigation.updateRouteState({});
    expect(shell.custodianMinimizeRequestId).toBe(0);

    shell.shellNavigation.updateRouteState({ routeId: "appearance" });
    expect(shell.custodianMinimizeRequestId).toBe(1);
  });
});

describe("OpenClaw shell server preferences", () => {
  it("refreshes live navigation from profile preferences rather than shared config", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    resetServerUiPrefsSync();
    const sidebarEntries = ["route:usage", "session:agent:main:test"];
    const request = vi.fn(async (method: string) => {
      expect(method).toBe("users.prefs.get");
      return {
        status: "ok",
        entries: { "ui.railShortcuts": sidebarEntries },
      };
    });
    const client = createTestGatewayClient(request);
    const gateway = {
      connection: { gatewayUrl: "ws://sidebar.test" },
      snapshot: { phase: "connected", client, selfUser: { id: "profile-a" } },
      subscribe: () => () => undefined,
    } as unknown as ApplicationGateway;
    const theme = createApplicationTheme(loadSettings(gateway.connection.gatewayUrl), gateway);
    const navigation = createApplicationNavigationPreferences(theme);
    const navigationChanged = vi.fn();
    const stopNavigation = navigation.subscribe(navigationChanged);
    onTestFinished(() => {
      stopNavigation();
      theme.dispose();
      resetServerUiPrefsSync();
    });
    const runtimeConfig = {
      state: {
        configSnapshot: {
          config: { ui: { prefs: { sidebarEntries: ["route:plugins"] } } },
          hash: "sidebar-config-hash",
        },
      },
    } as unknown as ApplicationContext["runtimeConfig"];
    const context = {
      gateway,
      navigation,
      theme,
      // reconcileServerUiPrefs only accepts the current context's capability.
      runtimeConfig,
    } as unknown as ApplicationContext;
    const shell = testShell(context);

    await shell.shellGateway.reconcileServerUiPrefs(runtimeConfig);

    expect(request).toHaveBeenCalledWith("users.prefs.get", expect.any(Object));
    expect(navigation.snapshot.sidebarEntries).toEqual(sidebarEntries);
    expect(navigationChanged).toHaveBeenCalledWith(expect.objectContaining({ sidebarEntries }));
    expect(loadSettings(gateway.connection.gatewayUrl).sidebarEntries).toEqual(sidebarEntries);
  });
});

describe("OpenClaw shell settings search", () => {
  it("does not load schema through a replaced runtime config capability", async () => {
    const loadGate = createDeferred();
    const firstRuntimeConfig = {
      ensureLoaded: vi.fn(() => loadGate.promise),
      ensureSchemaLoaded: vi.fn(() => Promise.resolve()),
    } as unknown as ApplicationContext["runtimeConfig"];
    const secondRuntimeConfig = {
      ensureLoaded: vi.fn(() => Promise.resolve()),
      ensureSchemaLoaded: vi.fn(() => Promise.resolve()),
    } as unknown as ApplicationContext["runtimeConfig"];
    const shell = testShell({ runtimeConfig: firstRuntimeConfig });

    const load = shell.handleSettingsSearchQueryChange("browser");
    shell.runtime = {
      context: { runtimeConfig: secondRuntimeConfig } as unknown as ApplicationContext,
    };
    loadGate.resolve();
    await load;

    expect(firstRuntimeConfig.ensureLoaded).toHaveBeenCalledOnce();
    expect(firstRuntimeConfig.ensureSchemaLoaded).not.toHaveBeenCalled();
    expect(secondRuntimeConfig.ensureSchemaLoaded).not.toHaveBeenCalled();
  });

  it("contains rejected schema loads within settings search", async () => {
    const runtimeConfig = {
      ensureLoaded: vi.fn(() => Promise.resolve()),
      ensureSchemaLoaded: vi.fn(() => Promise.reject(new Error("schema unavailable"))),
    } as unknown as ApplicationContext["runtimeConfig"];
    const shell = testShell({ runtimeConfig });

    await expect(shell.handleSettingsSearchQueryChange("browser")).resolves.toBeUndefined();

    expect(runtimeConfig.ensureLoaded).toHaveBeenCalledOnce();
    expect(runtimeConfig.ensureSchemaLoaded).toHaveBeenCalledOnce();
  });
});

describe("OpenClaw shell keyboard shortcuts", () => {
  it("resolves onboarding mode from the active route search", () => {
    expect(resolveOnboardingMode("?onboarding=1")).toBe(true);
    expect(resolveOnboardingMode("?onboarding=true")).toBe(true);
    expect(resolveOnboardingMode("?onboarding=0")).toBe(false);
    expect(resolveOnboardingMode("")).toBe(false);
  });

  it("merges shell chrome only for plain-browser mobile chat", () => {
    const shouldMerge = (overrides: Partial<Parameters<typeof shouldMergeChatChrome>[0]> = {}) =>
      shouldMergeChatChrome({
        mobileNavLayout: true,
        routeId: "chat",
        onboarding: false,
        ...overrides,
      });
    expect(shouldMerge()).toBe(true);
    expect(shouldMerge({ mobileNavLayout: false })).toBe(false);
    expect(shouldMerge({ routeId: "sessions" })).toBe(false);
    expect(shouldMerge({ onboarding: true })).toBe(false);

    document.documentElement.classList.add("openclaw-native-nav");
    expect(shouldMerge()).toBe(false);
  });

  it("prevents unhandled window file drops without overriding accepted targets", () => {
    const shell = testShell();
    const acceptedDropTarget = document.createElement("div");
    const nativeFileInput = document.createElement("input");
    nativeFileInput.type = "file";
    document.body.append(acceptedDropTarget, nativeFileInput);
    shell.connect();

    try {
      for (const type of ["dragover", "drop"] as const) {
        const unhandled = createDragEvent(type, ["Files"]);
        window.dispatchEvent(unhandled.event);
        expect(unhandled.event.defaultPrevented).toBe(true);
        expect(unhandled.dataTransfer.dropEffect).toBe("none");

        const accepted = createDragEvent(type, ["Files"]);
        acceptedDropTarget.addEventListener(type, (event) => event.preventDefault(), {
          once: true,
        });
        acceptedDropTarget.dispatchEvent(accepted.event);
        expect(accepted.event.defaultPrevented).toBe(true);
        expect(accepted.dataTransfer.dropEffect).toBe("copy");

        const nativeAccepted = createDragEvent(type, ["Files"]);
        nativeFileInput.dispatchEvent(nativeAccepted.event);
        expect(nativeAccepted.event.defaultPrevented).toBe(false);
        expect(nativeAccepted.dataTransfer.dropEffect).toBe("copy");

        const nonFile = createDragEvent(type, ["text/plain"]);
        window.dispatchEvent(nonFile.event);
        expect(nonFile.event.defaultPrevented).toBe(false);
        expect(nonFile.dataTransfer.dropEffect).toBe("copy");
      }
    } finally {
      shell.disconnect();
      acceptedDropTarget.remove();
      nativeFileInput.remove();
    }
  });

  it("closes an open navigation drawer before moving its sidebar into desktop layout", async () => {
    await import("../components/app-sidebar.tsx");
    vi.stubGlobal("matchMedia", () => Object.assign(new EventTarget(), { matches: false }));
    const runtime = bootstrapApplication();
    const shell = createShellOwner();
    shell.runtime = runtime;
    runtime.context.navigation.update({ navCollapsed: true });
    const updateNavigation = vi.spyOn(runtime.context.navigation, "update");
    const sidebar = shell.navigationSidebar;
    const dismissTransientMenus = vi.fn(() => true);
    sidebar.dismissTransientMenus = dismissTransientMenus;
    shell.element.append(sidebar);
    document.body.append(shell.element);
    const trigger = document.body.appendChild(document.createElement("button"));
    const restoreTriggerFocus = vi.spyOn(trigger, "focus");
    const closeNavDrawer = vi.spyOn(shell, "closeNavDrawer");
    shell.navDrawerOpen = true;
    shell.navDrawerTrigger = trigger;

    try {
      connectShellEvents(shell);
      window.dispatchEvent(new Event("resize"));

      expect(closeNavDrawer).toHaveBeenCalledExactlyOnceWith({ restoreFocus: false });
      expect(dismissTransientMenus).toHaveBeenCalledOnce();
      expect(restoreTriggerFocus).not.toHaveBeenCalled();
      expect(shell.navDrawerOpen).toBe(false);
      expect(shell.navDrawerTrigger).toBeNull();
      expect(updateNavigation).not.toHaveBeenCalled();
      expect(shell.desktopNavigationExpanded).toBe(true);
      shell.toggleNavigationSurface();
      expect(updateNavigation).toHaveBeenCalledExactlyOnceWith({ navCollapsed: true });
      expect(shell.desktopNavigationExpanded).toBe(false);

      document.body.append(sidebar);
      shell.navDrawerOpen = true;
      shell.navDrawerTrigger = trigger;
      shell.closeNavDrawer();
      expect(dismissTransientMenus).toHaveBeenCalledTimes(2);
      expect(shell.navDrawerOpen).toBe(false);
      expect(shell.navDrawerTrigger).toBeNull();
      expect(restoreTriggerFocus).not.toHaveBeenCalled();
    } finally {
      shell.disconnect();
      shell.element.remove();
      sidebar.remove();
      trigger.remove();
      runtime.stop();
    }
  });

  it("handles merged header drawer and palette requests", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const openPalette = vi.fn();
    const trigger = document.createElement("button");
    const shell = testShell({
      navigation: { snapshot: { navCollapsed: false }, update: vi.fn() },
    });
    Object.defineProperty(shell.elements, "commandPalette", {
      configurable: true,
      value: { isConnected: true, isOpen: false, openPalette, togglePalette: vi.fn() },
    });

    connectShellEvents(shell);
    window.dispatchEvent(new CustomEvent(SHELL_NAV_DRAWER_TOGGLE_EVENT, { detail: { trigger } }));
    window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));

    expect(shell.navDrawerOpen).toBe(true);
    expect(openPalette).toHaveBeenCalledOnce();
  });

  it("opens an unloaded palette only with the Mac platform shortcut", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const openPalette = vi.fn();
    const shell = configurePaletteShell(openPalette, false);
    connectShellEvents(shell);
    const chord = (metaKey: boolean) =>
      new KeyboardEvent("keydown", {
        key: "л",
        code: "KeyK",
        metaKey,
        ctrlKey: !metaKey,
        cancelable: true,
      });
    const other = chord(false);
    document.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
    expect(openPalette).not.toHaveBeenCalled();

    const primary = chord(true);
    document.dispatchEvent(primary);
    expect(primary.defaultPrevented).toBe(true);
    expect(shell.isShellComponentRequested("palette")).toBe(true);
    mountPalette(shell, openPalette);
    shell.restorePendingLazyAction();
    expect(openPalette).toHaveBeenCalledOnce();
  });

  it("clears a pending command palette action on Close", async () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const openPalette = vi.fn();
    const shell = configurePaletteShell(openPalette, false);
    await withConnectedShell(shell, () => {
      shell.openPalette();
      shell.closePendingPalette();
      expect(readLazyShellAction()).toBeNull();
      const replacement = configurePaletteShell(openPalette);
      replacement.restorePendingLazyAction();
      expect(openPalette).not.toHaveBeenCalled();
    });
  });

  it("does not clear an unrelated pending action from an already-loaded palette", async () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    persistLazyShellAction({ eventType: SHELL_APPROVALS_OPEN_EVENT });
    const openPalette = vi.fn();
    const shell = configurePaletteShell(openPalette);

    await withConnectedShell(shell, () => {
      shell.openPalette();

      expect(openPalette).toHaveBeenCalledOnce();
      expect(readLazyShellAction()).toEqual({ eventType: SHELL_APPROVALS_OPEN_EVENT });
    });
  });

  it("routes UI commands to navigation, panels, and chat fallback", () => {
    const update = vi.fn();
    const setSessionKey = vi.fn();
    const setAgent = vi.fn();
    const navigate = vi.fn();
    const panelEvent = vi.fn();
    const uiCommandEvent = vi.fn();
    const pluginPanelEvent = vi.fn();
    window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, panelEvent);
    window.addEventListener(UI_COMMAND_EVENT, uiCommandEvent);
    window.addEventListener(PLUGIN_PANEL_TOGGLE_EVENT, pluginPanelEvent);
    const shell = testShell({
      basePath: "",
      navigation: { update },
      gateway: { setSessionKey, snapshot: { hello: null } },
      agents: { state: { agentsList: { mainKey: "main" } } },
      agentSelection: { state: { selectedId: "main" }, set: setAgent },
      sessions: createRouteSessions(),
      chatSubmissions: createChatSubmissions(),
      navigate,
    });

    const send = (command: unknown, target: object = {}) =>
      shell.handleGatewayEvent({ event: "ui.command", payload: { command, ...target } });
    send({ kind: "sidebar", visible: false });
    send({
      kind: "panel",
      panel: "terminal",
      open: true,
      dock: "right",
      terminalSessionId: "terminal-agent-1",
    });
    send({
      kind: "split",
      direction: "right",
      sessionKey: "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
    });
    send({ kind: "focus", sessionKey: "agent:main:other" }, { sessionKey: "agent:main:source" });

    expect(update).toHaveBeenCalledWith({ navCollapsed: true });
    expect(panelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { open: true, dock: "right", terminalSessionId: "terminal-agent-1" },
      }),
    );
    expect(setSessionKey).toHaveBeenCalledWith(
      "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
    );
    // An uncached session's guessed face must be re-derived by the chat loader.
    expect(setAgent).toHaveBeenCalledWith("main");
    expect(navigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/main/1234567890abcdef1234567890abcdef",
      search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
    });
    expect(uiCommandEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: {
          command: { kind: "focus", sessionKey: "agent:main:other" },
          sessionKey: "agent:main:source",
        },
      }),
    );
    send(
      {
        kind: "panel",
        panel: "plugin",
        pluginId: "review",
        panelId: "document",
        open: true,
      },
      { sessionKey: "global", agentId: "writer" },
    );
    expect(setAgent).toHaveBeenLastCalledWith("writer");
    expect(setSessionKey).toHaveBeenLastCalledWith("global");
    expect(pluginPanelEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        detail: {
          sessionKey: "global",
          agentId: "writer",
          pluginId: "review",
          panelId: "document",
          open: true,
        },
      }),
    );
    window.removeEventListener(PLUGIN_PANEL_TOGGLE_EVENT, pluginPanelEvent);
    window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, panelEvent);
    window.removeEventListener(UI_COMMAND_EVENT, uiCommandEvent);
  });

  it("refreshes the roster on config.changed and invalidates removed or changed agents", async () => {
    vi.useFakeTimers();
    const harness = createRosterRefreshContext({
      previous: roster("main", [
        { id: "main", name: "Main" },
        { id: "writer", name: "Writer" },
        { id: "retired", name: "Retired" },
      ]),
      next: roster("main", [
        { id: "main", name: "Main" },
        { id: "writer", name: "Editor" },
        { id: "new-agent", name: "New" },
      ]),
      selectedId: "main",
    });
    const shell = testShell(harness.context);

    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.refreshConfig).toHaveBeenCalledOnce();
    expect(harness.refreshList).toHaveBeenCalledOnce();
    expect(harness.invalidateFiles).toHaveBeenCalledWith(["writer", "retired"]);
    expect(harness.invalidateIdentity).toHaveBeenCalledWith(["writer", "retired"]);
    expect(harness.ensureIdentity).toHaveBeenCalledWith(["writer"]);
    expect(harness.setSelection).not.toHaveBeenCalled();
  });

  it("moves a deleted active agent to the refreshed roster default", async () => {
    vi.useFakeTimers();
    const harness = createRosterRefreshContext({
      previous: roster("writer", [{ id: "fallback" }, { id: "main" }, { id: "writer" }]),
      next: roster("main", [{ id: "fallback" }, { id: "main" }]),
      selectedId: "writer",
    });
    const shell = testShell(harness.context);

    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.setSelection).toHaveBeenCalledExactlyOnceWith("main", { background: true });
  });

  it("coalesces config.changed bursts into one roster refresh", async () => {
    vi.useFakeTimers();
    const unchanged = roster("main", [{ id: "main" }]);
    const harness = createRosterRefreshContext({
      previous: unchanged,
      next: unchanged,
      selectedId: "main",
    });
    const shell = testShell(harness.context);

    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    await vi.advanceTimersByTimeAsync(99);
    expect(harness.refreshList).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(harness.refreshList).toHaveBeenCalledOnce();
    expect(harness.invalidateFiles).not.toHaveBeenCalled();
    expect(harness.invalidateIdentity).not.toHaveBeenCalled();
    expect(harness.ensureIdentity).not.toHaveBeenCalled();
  });
});
