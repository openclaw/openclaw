/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createComponent, onSettled } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import { visibleSettingsNavigationGroups } from "../app-navigation.ts";
import { createApplicationRouter } from "../app-routes.ts";
import type { AppSidebarElement } from "../components/app-sidebar.tsx";
import { createStoredChatOutboxReader } from "../lib/chat/outbox-store-projection.ts";
import { captureChatOutboxAdmission } from "../lib/chat/outbox-store.ts";
import type { SolidBridgeElement } from "../lib/solid-bridge.ts";
import {
  admitStoredChatComposerQueueItem,
  persistChatComposerState,
} from "../pages/chat/composer-persistence.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import {
  createContext,
  createGatewayHarness,
  createSessionsHarness,
} from "../test-helpers/app-sidebar.ts";
import {
  createApplicationContextProvider,
  createNavigationPreferencesFixture,
} from "../test-helpers/application-context.ts";
import { settleLitElements } from "../test-helpers/lit-settle.ts";
import "../components/app-sidebar.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  createShellOwner,
  mountShellView,
  refreshShellView,
} from "./app-host-solid.test-support.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context.ts";
import { createLazyRenderer } from "./lazy-renderer.ts";
import { ShellLayoutBoundary } from "./shell-layout-traits-solid.tsx";

type PairingSidebar = AppSidebarElement;

type PairingAuth = { role: string; scopes?: string[] };
const operator = (...scopes: string[]): PairingAuth => ({ role: "operator", scopes });
const admin = operator("operator.admin");
const pairingOnly = operator("operator.pairing");

function outboxes(sessionKey: string, total: number, draft: boolean) {
  return {
    total,
    sessions: total
      ? [{ agentId: "main", sessionKey, hasComposerDraft: draft, outboxAttentionCount: total }]
      : [],
    attentionCountForSession: () => total,
    hasSessionDraft: () => draft,
  };
}

function deferredRenderer<Renderer>(shell: object, property: string) {
  const loading = createDeferred<Renderer>();
  const retrying = createDeferred<Renderer>();
  const load = vi.fn(() => retrying.promise).mockImplementationOnce(() => loading.promise);
  Object.defineProperty(shell, property, { value: createLazyRenderer(load) });
  return { loading, retrying, load };
}

setupSidebarTest();

function createPairingShell(params: {
  auth: PairingAuth | null;
  connected?: boolean;
  setupCode?: string;
  access?: "full" | "limited" | "node";
  expiresAtMs?: number;
  sessionKeys?: string[];
}) {
  const gateway = createGatewayHarness({
    request: vi.fn(async () => ({})),
  } as unknown as GatewayBrowserClient);
  gateway.publish({
    phase: params.connected === false ? "stopped" : "connected",
    hello: params.auth ? ({ auth: params.auth } as ApplicationGatewaySnapshot["hello"]) : null,
    sessionKey: "main",
  });
  const snapshot = gateway.gateway.snapshot;
  const sessions = createSessionsHarness("main", params.sessionKeys ?? []);
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
    ...createContext(gateway.gateway, sessions.sessions),
    basePath: "",
    navigation: createNavigationPreferencesFixture(),
    overlays: {
      snapshot: overlaySnapshot,
      openDevicePairSetup,
      closeDevicePairSetup: vi.fn(() => {
        overlaySnapshot.devicePairSetupOpen = false;
      }),
      subscribe: () => () => undefined,
    },
    settingsAgentSelection: {
      state: { selectedId: "main", scopeId: "main" },
      intentRevision: 0,
      set: vi.fn(),
      setScope: vi.fn(),
      subscribe: () => () => undefined,
    },
  } as unknown as ApplicationContext;
  const shell = createShellOwner();
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
  const container = shell.element;
  onTestFinished(() => router.stop());
  let mounted = false;
  const refresh = async () => {
    if (!mounted) {
      mountShellView(shell);
      mounted = true;
    } else {
      refreshShellView(shell);
    }
    await Promise.resolve();
    flush();
  };

  const renderSidebar = async () => {
    await refresh();
    return expectDefined(
      container.querySelector<PairingSidebar>("openclaw-app-sidebar"),
      "shell sidebar",
    );
  };

  const renderPairingDialog = async () => {
    await renderSidebar();
    await vi.dynamicImportSettled();
    return await waitForFast(async () => {
      await refresh();
      return expectDefined(
        container.querySelector<HTMLElement>('.device-pair-setup:not([aria-busy="true"])'),
        "loaded pairing dialog",
      );
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
    refresh,
  };
}

afterEach(() => {
  Reflect.deleteProperty(document, "execCommand");
});

describe("application shell pairing access", () => {
  it("projects current-account draft and outbox through the real shell, then fences offline retirement", async () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { shell, context, snapshot, renderSidebar } = createPairingShell({
      auth: null,
      connected: false,
    });
    const client = new GatewayBrowserClient({
      url: context.gateway.connection.gatewayUrl,
      offlineRecoveryScope: "account-a",
    });
    snapshot.client = client;
    const host = {
      settings: context.gateway.connection,
      client,
      connected: false,
      sessionKey: "agent:main:main",
      chatMessage: "private draft",
      chatQueue: [],
    };
    expect(persistChatComposerState(host)).toBe(true);
    expect(
      admitStoredChatComposerQueueItem(host, captureChatOutboxAdmission(host, host.sessionKey), {
        id: "failed",
        text: "private queued input",
        createdAt: 1,
        sendState: "failed",
      }),
    ).toBe(true);
    shell.outboxStoreRuntime = createStoredChatOutboxReader();
    const first = (await renderSidebar()).storedOutboxes!;
    expect(first.total).toBe(1);
    expect(first.attentionCountForSession(host.sessionKey)).toBe(1);
    expect(first.hasSessionDraft(host.sessionKey)).toBe(true);
    // Same client and unchanged live recovery fields: only retained admission retired.
    client.retireOfflineRecoveryScope();
    const retired = (await renderSidebar()).storedOutboxes!;
    expect(retired.total).toBe(0);
    expect(retired.hasSessionDraft(host.sessionKey)).toBe(false);
    expect(retired).not.toBe(first);
    snapshot.client = new GatewayBrowserClient({
      url: context.gateway.connection.gatewayUrl,
      offlineRecoveryScope: "account-b",
    });
    expect((await renderSidebar()).storedOutboxes!.total).toBe(0);
    snapshot.client = new GatewayBrowserClient({
      url: context.gateway.connection.gatewayUrl,
      offlineRecoveryScope: "account-a",
    });
    expect((await renderSidebar()).storedOutboxes!.total).toBe(1);
  });

  it.each([false, true])(
    "retains navigation chrome for unrelated shell updates (outbox runtime: %s)",
    async (withOutboxes) => {
      vi.useFakeTimers();
      const sessionKey = "agent:main:queued";
      const { shell, context, renderSidebar, container, overlaySnapshot, refresh } =
        createPairingShell({
          auth: admin,
          sessionKeys: [sessionKey],
        });
      let storedOutboxes = outboxes(sessionKey, 1, true);
      if (withOutboxes) {
        shell.outboxStoreRuntime = {
          read: () => storedOutboxes,
          subscribe: () => () => undefined,
          invalidate: () => undefined,
        };
      }
      const sidebar = await renderSidebar();
      const topbar = container.querySelector<SolidBridgeElement<object>>("openclaw-app-topbar")!;
      const provider = createApplicationContextProvider(context);
      provider.append(sidebar, topbar);
      document.body.append(provider);
      await settleLitElements([sidebar, topbar]);
      await vi.dynamicImportSettled();
      await settleLitElements([sidebar, topbar]);
      const conversation = () =>
        sidebar.querySelector<HTMLElement>(
          `.sidebar-recent-session[data-session-key="${sessionKey}"]`,
        );
      await waitForSolid(() => expect(conversation()).not.toBeNull());
      if (withOutboxes) {
        expect(
          conversation()?.querySelector(".session-row-badge--attention")?.textContent,
        ).toContain("1");
        expect(conversation()?.querySelector(".session-row-badge--draft")).not.toBeNull();
      }
      const sidebarFrame = sidebar.querySelector("aside");
      const conversationRow = conversation();
      const sidebarText = sidebar.textContent;
      const topbarText = topbar.textContent;
      const sidebarUpdates: MutationRecord[] = [];
      const observer = new MutationObserver((records) => sidebarUpdates.push(...records));
      observer.observe(sidebar, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      onTestFinished(() => observer.disconnect());
      const topbarFrame = topbar.querySelector(".topbar");
      const topbarToggle = topbar.querySelector(".topbar-nav-toggle");
      expect(topbarFrame).not.toBeNull();
      expect(topbarToggle).not.toBeNull();

      overlaySnapshot.approvalBusy = true;
      await refresh();
      await settleLitElements([sidebar, topbar]);
      flush();

      expect([...sidebarUpdates, ...observer.takeRecords()]).toHaveLength(0);
      expect(sidebar.querySelector("aside")).toBe(sidebarFrame);
      expect(conversation()).toBe(conversationRow);
      expect(topbar.querySelector(".topbar")).toBe(topbarFrame);
      expect(topbar.querySelector(".topbar-nav-toggle")).toBe(topbarToggle);
      expect(sidebar.textContent).toBe(sidebarText);
      expect(topbar.textContent).toBe(topbarText);
      expect(sidebar.storedOutboxes?.attentionCountForSession(sessionKey) ?? 0).toBe(
        withOutboxes ? 1 : 0,
      );
      expect(sidebar.storedOutboxes?.hasSessionDraft(sessionKey) ?? false).toBe(withOutboxes);
      if (withOutboxes) {
        storedOutboxes = outboxes(sessionKey, 2, false);
        await refresh();
        await settleLitElements([sidebar, topbar]);
        await waitForSolid(() =>
          expect(
            conversation()?.querySelector(".session-row-badge--attention")?.textContent,
          ).toContain("2"),
        );
        expect(conversation()?.querySelector(".session-row-badge--draft")).toBeNull();
      }
    },
  );

  it("keeps resident navigation actions bound to current context and permission", async () => {
    const { shell, renderSidebar, openDevicePairSetup } = createPairingShell({ auth: admin });
    const sidebar = await renderSidebar();
    const {
      onPairMobile,
      onRetryConnect,
      onOpenNewSession,
      onUpdateSidebarEntries,
      watchUpdateProgress,
    } = sidebar;
    const replacement = createPairingShell({ auth: admin });
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
      auth: operator("operator.read"),
    } as ApplicationGatewaySnapshot["hello"];
    onOpenNewSession?.("main");
    expect(openNewSession).toHaveBeenCalledOnce();
  });

  it("updates the shell when the stored outbox changes", async () => {
    vi.useFakeTimers();
    let publish: (() => void) | undefined;
    const shell = createShellOwner();
    shell.outboxStoreRuntime = {
      read: () => outboxes("", 0, false),
      subscribe: (listener) => {
        publish = listener;
        return () => {
          publish = undefined;
        };
      },
      invalidate: () => undefined,
    };
    document.body.append(shell.element, shell.navigationSidebar);
    shell.connect();
    try {
      await settleLitElements([shell.navigationSidebar as PairingSidebar]);
      const update = vi.spyOn(shell, "invalidate");

      publish?.();

      expect(update).toHaveBeenCalledOnce();
      flush();
    } finally {
      shell.disconnect();
      shell.element.remove();
      shell.navigationSidebar.remove();
    }
    expect(publish).toBeUndefined();
  });

  it.each([
    ["legacy authenticated", { role: "operator" }, true],
    ["legacy unadvertised", null, true],
    ["read-only", operator("operator.read"), false],
    ["write-only", operator("operator.write"), false],
    ["pairing-only", pairingOnly, false],
    ["explicitly ungranted", operator(), false],
    ["disconnected", pairingOnly, false, false],
    ["admin becoming pairing-only", admin, true, true, pairingOnly],
  ] satisfies [string, PairingAuth | null, boolean, boolean?, PairingAuth?][])(
    "gates the sidebar pairing entry for a %s operator",
    async (_name, auth, canPair, connected?: boolean, nextAuth?: PairingAuth) => {
      const { snapshot, openDevicePairSetup, renderSidebar } = createPairingShell({
        auth,
        connected,
      });
      expect((await renderSidebar()).canPairDevice).toBe(canPair);
      if (nextAuth) {
        snapshot.hello = { auth: nextAuth } as ApplicationGatewaySnapshot["hello"];
        const sidebar = await renderSidebar();
        expect(sidebar.canPairDevice).toBe(false);
        sidebar.onPairMobile?.();
        expect(openDevicePairSetup).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    ["pairing", false],
    ["pairing", true],
    ["settings", false],
    ["settings", true],
  ] as const)("keeps lazy %s visible (failed: %s)", async (surface, failed) => {
    const settings = surface === "settings";
    const { shell, container, refresh, renderSidebar } = createPairingShell({
      auth: settings ? { role: "operator" } : admin,
      setupCode: settings ? undefined : "pair-mobile-secret",
    });
    const property = settings ? "settingsSidebar" : "devicePairSetup";
    type Renderer = NonNullable<ReturnType<(typeof shell)[typeof property]["renderer"]>>;
    const { loading, retrying, load } = deferredRenderer<Renderer>(shell, property);
    if (settings) {
      shell.routeState = {
        routeId: "profile",
        location: { pathname: "/settings/profile", search: "", hash: "" },
      };
      await refresh();
    } else {
      await renderSidebar();
    }
    const message = settings
      ? "Settings navigation could not load."
      : "Could not load the pairing dialog";
    if (failed) {
      loading.reject(new Error(`${surface} chunk unavailable`));
      await waitForSolid(() => expect(container.textContent).toContain(message));
    }
    const target = container.querySelector<HTMLElement>(
      settings ? ".settings-sidebar" : ".device-pair-setup",
    );
    if (failed) {
      expect(target?.textContent).toContain(message);
      if (settings) {
        expect(target?.getAttribute("aria-busy")).toBeNull();
      }
      const actions = [
        ...(target?.querySelectorAll<HTMLButtonElement>(
          settings ? "button" : ".device-pair-setup__footer button",
        ) ?? []),
      ];
      if (!settings) {
        expect(actions.map((button) => button.textContent?.trim())).toEqual(["Retry", "Close"]);
      }
      actions.find((button) => button.textContent?.trim() === "Retry")?.click();
      await waitForSolid(() => expect(target?.getAttribute("aria-busy")).toBe("true"));
    } else {
      expect(target?.getAttribute("aria-busy")).toBe("true");
      if (settings) {
        const skeleton = target?.querySelector<HTMLElement>(
          '.settings-sidebar__loading[role="status"][aria-busy="true"]',
        );
        expect(skeleton?.getAttribute("aria-label")).toBe("Loading…");
        const expectedItems = visibleSettingsNavigationGroups(true).reduce(
          (count, group) => count + group.routes.length,
          0,
        );
        for (const selector of [
          ".settings-sidebar__loading-item",
          ".settings-sidebar__loading-item .settings-sidebar__loading-icon",
        ]) {
          expect(skeleton?.querySelectorAll(selector)).toHaveLength(expectedItems);
        }
      } else {
        expect(target?.textContent).toContain("Loading…");
        expect(load).toHaveBeenCalledOnce();
      }
    }
    if (settings) {
      expect(load).toHaveBeenCalledTimes(failed ? 2 : 1);
      (failed ? retrying : loading).resolve(() => document.createTextNode("Settings ready"));
      await waitForSolid(() => expect(container.textContent).toContain("Settings ready"));
      expect(container.querySelector(".settings-sidebar__loading")).toBeNull();
    }
  });

  it("shows a visible accessible error when a mobile setup code cannot be copied", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Clipboard access denied"));
    const execCommand = vi.fn(() => false);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const schedule = vi.spyOn(window, "setTimeout");
    const { container, renderPairingDialog } = createPairingShell({
      auth: admin,
      setupCode: "pair-mobile-secret",
    });
    document.body.append(container);
    const pairing = await renderPairingDialog();
    const button = pairing.querySelector<HTMLButtonElement>(
      ".device-pair-setup__actions button:has([data-copy-label])",
    );

    button?.click();
    expect(writeText).toHaveBeenCalledWith("pair-mobile-secret");

    await waitForFast(() => expect(button?.textContent?.trim()).toBe("Copy failed"));
    expect(button?.getAttribute("aria-label")).toBeNull();
    expect(button?.querySelector("svg")).not.toBeNull();
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
    const { container, renderSidebar, refresh } = createPairingShell({
      auth: admin,
      setupCode: "pair-node-secret",
      access: "node",
      expiresAtMs: 5_000,
    });

    await renderSidebar();
    await vi.dynamicImportSettled();
    await waitForFast(async () => {
      await refresh();
      expect(container.querySelector('[role="timer"]')?.textContent).toContain("0:01");
    });
    expect(container.querySelector(".device-pair-setup__command code")).not.toBeNull();

    now.mockReturnValue(5_000);
    await refresh();
    expect(container.querySelector('[role="timer"]')?.textContent?.toLowerCase()).toContain(
      "expired",
    );
    expect(container.querySelector(".device-pair-setup__command code")).toBeNull();
  });

  it("publishes layout traits from an already-loaded native route on shell mount", async () => {
    const { shell, context, container, refresh } = createPairingShell({ auth: null });
    const router = shell.runtime!.router;
    const definition = router.getRoute("activity")!;
    vi.spyOn(definition, "component").mockResolvedValue({
      renderSolid: () =>
        createComponent(ShellLayoutBoundary, {
          traits: { toolbarHeader: true, activityPage: true },
          children: "Native activity page",
        }),
    });
    await router.navigate("activity", context);
    shell.routeState = {
      routeId: "activity",
      location: { pathname: "/activity", search: "", hash: "" },
    };
    document.body.append(container);
    await refresh();
    await new Promise<void>((resolve) => {
      onSettled(resolve);
    });
    expect(container.textContent).toContain("Native activity page");
    const content = container.querySelector("main.content")!;
    expect(content.classList.contains("content--toolbar-header")).toBe(true);
    expect(content.classList.contains("content--activity-page")).toBe(true);
  });
});
