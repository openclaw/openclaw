/* @vitest-environment jsdom */

import { render, type LitElement, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { visibleSettingsNavigationGroups } from "../app-navigation.ts";
import { createApplicationRouter } from "../app-routes.ts";
import "../components/app-sidebar.ts";
import { settleLitElements } from "../test-helpers/lit-settle.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import type { OutboxStoreRuntime } from "./app-shell-gateway.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context.ts";
import { loadSettings } from "./settings.ts";
import "./app-host.ts";
import type { UpdateProgress } from "./update-confirmation.ts";

type PairingShell = HTMLElement & {
  runtime?: ApplicationRuntime;
  render: () => TemplateResult;
  routeState: {
    routeId?: string;
    location?: { pathname: string; search: string; hash: string };
  };
  devicePairSetupRenderer: unknown;
  devicePairSetupLoadFailed: boolean;
  loadDevicePairSetupRenderer: () => void;
  settingsSidebarRenderer: unknown;
  settingsSidebarLoadFailed: boolean;
  loadSettingsSidebarRenderer: () => void;
  retrySettingsSidebarRenderer: () => void;
  outboxStoreRuntime: OutboxStoreRuntime | null;
  openNewSession: (agentId: string) => void;
};

type PairingSidebar = LitElement & {
  render: () => TemplateResult;
  canPairDevice: boolean;
  onPairMobile?: () => void;
  onRetryConnect?: () => void;
  onOpenNewSession?: (agentId: string) => void;
  onUpdateSidebarEntries?: (entries: string[]) => void;
  watchUpdateProgress?: (listener: (progress: UpdateProgress) => void) => () => void;
  outboxAttentionCountForSession: (sessionKey: string) => number;
  hasSessionDraft: (sessionKey: string) => boolean;
};

type PairingAuth = { role: string; scopes?: string[] };

function createPairingShell(params: {
  auth: PairingAuth | null;
  connected?: boolean;
  setupCode?: string;
  access?: "full" | "limited" | "node";
  expiresAtMs?: number;
}) {
  const snapshot: ApplicationGatewaySnapshot = {
    client: { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient,
    phase: params.connected === false ? "stopped" : "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: params.auth ? ({ auth: params.auth } as ApplicationGatewaySnapshot["hello"]) : null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const openDevicePairSetup = vi.fn(async () => undefined);
  const access = params.access ?? "full";
  const overlaySnapshot = {
    approvalQueue: [],
    approvalErrors: new Map(),
    approvalBusy: false,
    devicePairSetupOpen: Boolean(params.setupCode),
    devicePairSetupLifecycle: params.setupCode
      ? {
          phase: "waiting" as const,
          access,
          setup: {
            setupId: "setup-copy-test",
            expiresAtMs: params.expiresAtMs ?? Date.now() + 60_000,
            setupCode: params.setupCode,
            gatewayUrl: "wss://gateway.example.test",
            auth: "token",
            urlSource: "test",
            access,
          },
        }
      : { phase: "selection" as const, access },
    devicePairPendingCount: 0,
    updateAvailable: null,
    updateRunning: false,
    updateStatusBanner: null,
    recordedUpdateAttempt: null,
    controlUiRefreshRequired: false,
  };
  const context = {
    basePath: "",
    gateway: {
      snapshot,
      connection: { gatewayUrl: "ws://gateway.test", token: "", password: "" },
    },
    navigation: {
      snapshot: { navCollapsed: false, navWidth: 258, sidebarEntries: [], pinnedAgentIds: [] },
    },
    overlays: {
      snapshot: overlaySnapshot,
      openDevicePairSetup,
    },
    config: { current: {} },
    runtimeConfig: {
      state: { configSnapshot: null, configForm: null, configSchema: null, configUiHints: {} },
    },
    agents: { state: { agentsList: null } },
    agentSelection: { state: { selectedId: "main", scopeId: "main" } },
    sessions: { state: { result: null } },
    theme: { mode: "system", settings: loadSettings() },
  } as unknown as ApplicationContext;
  const shell = document.createElement("openclaw-app-shell") as PairingShell;
  const router = createApplicationRouter();
  shell.runtime = {
    context,
    router,
    documentMode: null,
    warmBoot: false,
    focusLocation: null,
    pendingGatewayConnection: null,
    confirmPendingGatewayConnection: () => undefined,
    cancelPendingGatewayConnection: () => undefined,
    start: async () => undefined,
    stop: () => router.stop(),
  };
  shell.routeState = {
    routeId: "chat",
    location: { pathname: "/chat", search: "", hash: "" },
  };
  const container = document.createElement("div");
  onTestFinished(() => {
    render(null, container);
    router.stop();
  });

  const renderSidebar = () => {
    render(shell.render(), container);
    const sidebar = container.querySelector<PairingSidebar>("openclaw-app-sidebar");
    if (!sidebar) {
      throw new Error("Expected the application shell to render its navigation sidebar");
    }
    return sidebar;
  };

  // The pairing modal is a lazy chunk; re-render until the loaded renderer
  // replaces the eager loading shell with the full dialog.
  const renderPairingDialog = async () => {
    renderSidebar();
    await vi.dynamicImportSettled();
    return await waitForFast(() => {
      render(shell.render(), container);
      const dialog = container.querySelector<HTMLElement>(
        '.device-pair-setup:not([aria-busy="true"])',
      );
      if (!dialog) {
        throw new Error("Expected the application shell to render its mobile pairing dialog");
      }
      return dialog;
    });
  };

  return {
    shell,
    context,
    snapshot,
    overlaySnapshot,
    openDevicePairSetup,
    renderSidebar,
    renderPairingDialog,
    container,
  };
}

afterEach(async () => {
  await vi.dynamicImportSettled();
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "execCommand");
});

describe("application shell pairing access", () => {
  it.each([false, true])(
    "does not rerender navigation chrome for unrelated shell updates (outbox runtime: %s)",
    async (withOutboxes) => {
      vi.useFakeTimers();
      const { shell, renderSidebar, container, overlaySnapshot } = createPairingShell({
        auth: { role: "operator", scopes: ["operator.admin"] },
      });
      if (withOutboxes) {
        shell.outboxStoreRuntime = {
          read: () => ({
            total: 1,
            attentionCountForSession: () => 1,
            hasSessionDraft: () => true,
          }),
          subscribe: () => () => undefined,
          invalidate: () => undefined,
        };
      }
      const sidebar = renderSidebar();
      const topbar = container.querySelector<LitElement & { render: () => TemplateResult }>(
        "openclaw-app-topbar",
      )!;
      document.body.append(sidebar, topbar);
      await settleLitElements([sidebar, topbar]);
      await vi.dynamicImportSettled();
      await settleLitElements([sidebar, topbar]);
      expect(sidebar.isUpdatePending).toBe(false);
      const sidebarText = sidebar.textContent;
      const topbarText = topbar.textContent;
      const renderSidebarChild = vi.spyOn(sidebar, "render");
      const renderTopbarChild = vi.spyOn(topbar, "render");

      overlaySnapshot.approvalBusy = true;
      render(shell.render(), container);
      await settleLitElements([sidebar, topbar]);

      expect(renderSidebarChild).not.toHaveBeenCalled();
      expect(renderTopbarChild).not.toHaveBeenCalled();
      expect(sidebar.textContent).toBe(sidebarText);
      expect(topbar.textContent).toBe(topbarText);
      expect(sidebar.outboxAttentionCountForSession("agent:main:main")).toBe(withOutboxes ? 1 : 0);
      expect(sidebar.hasSessionDraft("agent:main:main")).toBe(withOutboxes);
    },
  );

  it("keeps resident navigation actions bound to current context and permission", () => {
    const { shell, renderSidebar, openDevicePairSetup } = createPairingShell({
      auth: { role: "operator", scopes: ["operator.admin"] },
    });
    const sidebar = renderSidebar();
    const {
      onPairMobile,
      onRetryConnect,
      onOpenNewSession,
      onUpdateSidebarEntries,
      watchUpdateProgress,
    } = sidebar;
    const replacement = createPairingShell({
      auth: { role: "operator", scopes: ["operator.admin"] },
    });
    replacement.snapshot.hello = {
      ...replacement.snapshot.hello,
      features: { methods: ["sessions.create"], events: [] },
    } as ApplicationGatewaySnapshot["hello"];
    const connect = vi.fn();
    const update = vi.fn();
    const stopGateway = vi.fn();
    const stopOverlays = vi.fn();
    replacement.context.gateway.connect = connect;
    replacement.context.gateway.subscribe = vi.fn(() => stopGateway);
    replacement.context.navigation.update = update;
    replacement.context.overlays.subscribe = vi.fn(() => stopOverlays);
    shell.runtime = { ...shell.runtime!, context: replacement.context };
    const openNewSession = vi.spyOn(shell, "openNewSession").mockImplementation(() => undefined);

    onPairMobile?.();
    onRetryConnect?.();
    onUpdateSidebarEntries?.(["chat", "activity"]);
    onOpenNewSession?.("main");
    const progress = vi.fn();
    const stopProgress = watchUpdateProgress?.(progress);

    expect(openDevicePairSetup).not.toHaveBeenCalled();
    expect(replacement.openDevicePairSetup).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({ sidebarEntries: ["chat", "activity"] });
    expect(openNewSession).toHaveBeenCalledExactlyOnceWith("main", undefined);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
    stopProgress?.();
    expect(stopGateway).toHaveBeenCalledOnce();
    expect(stopOverlays).toHaveBeenCalledOnce();
    replacement.snapshot.hello = {
      ...replacement.snapshot.hello,
      auth: { role: "operator", scopes: ["operator.read"] },
    } as ApplicationGatewaySnapshot["hello"];
    onOpenNewSession?.("main");
    expect(openNewSession).toHaveBeenCalledOnce();
  });

  it("invalidates the resident sidebar when the stored outbox changes", async () => {
    vi.useFakeTimers();
    let publish: (() => void) | undefined;
    const shell = document.createElement("openclaw-app-shell") as LitElement & {
      outboxStoreRuntime: OutboxStoreRuntime;
      navigationSidebar: PairingSidebar;
    };
    shell.outboxStoreRuntime = {
      read: () => ({
        total: 0,
        attentionCountForSession: () => 0,
        hasSessionDraft: () => false,
      }),
      subscribe: (listener) => {
        publish = listener;
        return () => {
          publish = undefined;
        };
      },
      invalidate: () => undefined,
    };
    document.body.append(shell, shell.navigationSidebar);
    try {
      await settleLitElements([shell, shell.navigationSidebar]);
      expect(shell.isUpdatePending).toBe(false);
      expect(shell.navigationSidebar.isUpdatePending).toBe(false);

      publish?.();

      expect(shell.isUpdatePending).toBe(true);
      expect(shell.navigationSidebar.isUpdatePending).toBe(true);
    } finally {
      shell.remove();
      shell.navigationSidebar.remove();
    }
    expect(publish).toBeUndefined();
  });

  it.each([
    {
      name: "pairing-only",
      auth: { role: "operator", scopes: ["operator.pairing"] },
      canPair: true,
    },
    {
      name: "administrator",
      auth: { role: "operator", scopes: ["operator.admin"] },
      canPair: true,
    },
    { name: "legacy authenticated", auth: { role: "operator" }, canPair: true },
    { name: "legacy unadvertised", auth: null, canPair: true },
    { name: "read-only", auth: { role: "operator", scopes: ["operator.read"] }, canPair: false },
    { name: "write-only", auth: { role: "operator", scopes: ["operator.write"] }, canPair: false },
    { name: "explicitly ungranted", auth: { role: "operator", scopes: [] }, canPair: false },
  ])("gates the sidebar pairing entry for a $name operator", ({ auth, canPair }) => {
    const { renderSidebar } = createPairingShell({ auth });

    expect(renderSidebar().canPairDevice).toBe(canPair);
  });

  it("keeps the pairing entry accessible after admin becomes pairing-only", () => {
    const { snapshot, openDevicePairSetup, renderSidebar } = createPairingShell({
      auth: { role: "operator", scopes: ["operator.admin"] },
    });
    expect(renderSidebar().canPairDevice).toBe(true);

    snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.pairing"] },
    } as ApplicationGatewaySnapshot["hello"];
    const sidebar = renderSidebar();

    expect(sidebar.canPairDevice).toBe(true);
    sidebar.onPairMobile?.();
    expect(openDevicePairSetup).toHaveBeenCalledOnce();
  });

  it("keeps the pairing entry disabled while the gateway is disconnected", () => {
    const { renderSidebar } = createPairingShell({
      auth: { role: "operator", scopes: ["operator.pairing"] },
      connected: false,
    });

    expect(renderSidebar().canPairDevice).toBe(false);
  });

  it("keeps a failed pairing dialog load visible and retryable", () => {
    const { shell, renderSidebar, container } = createPairingShell({
      auth: { role: "operator", scopes: ["operator.pairing"] },
      setupCode: "pair-mobile-secret",
    });
    renderSidebar();

    // Force the rejected-chunk state the shell reaches when the lazy pairing
    // import fails while its overlay is already open.
    shell.devicePairSetupRenderer = null;
    shell.devicePairSetupLoadFailed = true;
    render(shell.render(), container);

    const dialog = container.querySelector<HTMLElement>(".device-pair-setup");
    expect(dialog?.textContent).toContain("Could not load the pairing dialog");
    const actions = [
      ...container.querySelectorAll<HTMLButtonElement>(".device-pair-setup__footer button"),
    ];
    expect(actions.map((button) => button.textContent?.trim())).toEqual(["Retry", "Close"]);

    actions[0]?.click();

    expect(shell.devicePairSetupLoadFailed).toBe(false);
  });

  it("keeps the pairing dialog visible while its lazy renderer is loading", () => {
    const { shell, renderSidebar, container } = createPairingShell({
      auth: { role: "operator", scopes: ["operator.pairing"] },
      setupCode: "pair-mobile-secret",
    });
    const loadRenderer = vi.fn();
    shell.devicePairSetupRenderer = null;
    shell.devicePairSetupLoadFailed = false;
    shell.loadDevicePairSetupRenderer = loadRenderer;

    renderSidebar();

    const dialog = container.querySelector<HTMLElement>(".device-pair-setup");
    expect(dialog?.getAttribute("aria-busy")).toBe("true");
    expect(dialog?.textContent).toContain("Loading…");
    expect(loadRenderer).toHaveBeenCalledOnce();
  });

  it("keeps settings navigation visibly loading while its renderer downloads", () => {
    const { shell, container } = createPairingShell({ auth: { role: "operator" } });
    const loadRenderer = vi.fn();
    shell.routeState = {
      routeId: "profile",
      location: { pathname: "/settings/profile", search: "", hash: "" },
    };
    shell.settingsSidebarRenderer = null;
    shell.settingsSidebarLoadFailed = false;
    shell.loadSettingsSidebarRenderer = loadRenderer;

    render(shell.render(), container);

    const sidebar = container.querySelector<HTMLElement>(".settings-sidebar");
    expect(sidebar?.getAttribute("aria-busy")).toBe("true");
    const loadingSkeleton = sidebar?.querySelector<HTMLElement>(
      '.settings-sidebar__loading[role="status"][aria-busy="true"]',
    );
    expect(loadingSkeleton?.getAttribute("aria-label")).toBe("Loading…");
    // Legacy operator auth (no scopes) resolves to admin access, so the skeleton
    // must draw the full admin navigation.
    const expectedItems = visibleSettingsNavigationGroups(true).reduce(
      (count, group) => count + group.routes.length,
      0,
    );
    expect(loadingSkeleton?.querySelectorAll(".settings-sidebar__loading-item")).toHaveLength(
      expectedItems,
    );
    expect(
      loadingSkeleton?.querySelectorAll(
        ".settings-sidebar__loading-item .settings-sidebar__loading-icon",
      ),
    ).toHaveLength(expectedItems);
    expect(loadRenderer).toHaveBeenCalledOnce();
  });

  it("keeps a failed settings navigation load visible and retryable", () => {
    const { shell, container } = createPairingShell({ auth: { role: "operator" } });
    const retryRenderer = vi.fn();
    shell.routeState = {
      routeId: "profile",
      location: { pathname: "/settings/profile", search: "", hash: "" },
    };
    shell.settingsSidebarRenderer = null;
    shell.settingsSidebarLoadFailed = true;
    shell.retrySettingsSidebarRenderer = retryRenderer;

    render(shell.render(), container);

    const sidebar = container.querySelector<HTMLElement>(".settings-sidebar");
    expect(sidebar?.getAttribute("aria-busy")).toBeNull();
    expect(sidebar?.textContent).toContain("Settings navigation could not load.");
    const retry = [...(sidebar?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Retry",
    );
    retry?.click();
    expect(retryRenderer).toHaveBeenCalledOnce();
  });

  it("shows a visible accessible error when a mobile setup code cannot be copied", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Clipboard access denied"));
    const execCommand = vi.fn(() => false);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const schedule = vi.spyOn(window, "setTimeout");
    const { renderPairingDialog } = createPairingShell({
      auth: { role: "operator", scopes: ["operator.pairing"] },
      setupCode: "pair-mobile-secret",
    });
    const pairing = await renderPairingDialog();
    document.body.append(pairing);
    const button = pairing.querySelector<HTMLButtonElement>(".device-pair-setup__actions button");

    button?.click();

    await waitForFast(() => expect(button?.textContent?.trim()).toBe("Copy failed"));
    expect(button?.getAttribute("aria-label")).toBeNull();
    expect(button?.querySelector("svg")).not.toBeNull();
    expect(writeText).toHaveBeenCalledWith("pair-mobile-secret");
    expect(execCommand).toHaveBeenCalledWith("copy");

    const reset = schedule.mock.calls.find(([, delay]) => delay === 2_000)?.[0];
    if (typeof reset !== "function") {
      throw new Error("Expected the failed copy feedback to schedule its reset");
    }
    reset();

    expect(button?.textContent?.trim()).toBe("Copy setup code");
    expect(button?.getAttribute("aria-label")).toBeNull();
  });

  it("expires a node setup link from the pairing clock", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(4_000);
    const { shell, container, renderSidebar } = createPairingShell({
      auth: { role: "operator", scopes: ["operator.pairing"] },
      setupCode: "pair-node-secret",
      access: "node",
      expiresAtMs: 5_000,
    });

    renderSidebar();
    await vi.dynamicImportSettled();
    await waitForFast(() => {
      render(shell.render(), container);
      expect(container.querySelector('[role="timer"]')?.textContent).toContain("0:01");
    });
    expect(container.querySelector(".device-pair-setup__command code")).not.toBeNull();

    now.mockReturnValue(5_000);
    render(shell.render(), container);
    expect(container.querySelector('[role="timer"]')?.textContent?.toLowerCase()).toContain(
      "expired",
    );
    expect(container.querySelector(".device-pair-setup__command code")).toBeNull();
  });
});
