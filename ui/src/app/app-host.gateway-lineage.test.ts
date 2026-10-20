import { parseControlUiFocusLocation } from "@openclaw/session-url-contract";
import { createComponent, flush } from "solid-js";
/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayBrowserClient,
  GatewayBrowserClientOptions,
  GatewayHelloOk,
} from "../api/gateway.ts";
import type { AgentsListResult } from "../api/types.ts";
import type { LoginGateElement } from "../components/login-gate.ts";
import { captureChatOutboxAdmission, storageTargetForComposer } from "../lib/chat/outbox-store.ts";
import "../components/login-gate.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import {
  createComposerContainer,
  createComposerProps,
  resetComposerFixture,
} from "../pages/chat/chat-composer.test-support.ts";
import { admitQueuedMessageForSession } from "../pages/chat/chat-outbox-admission.test-support.ts";
import { chatOutboxOwner } from "../pages/chat/chat-outbox-owner.ts";
import { createTestChatPane } from "../pages/chat/chat-pane.test-support.ts";
import { handleSendChat } from "../pages/chat/chat-send-submit.ts";
import { ChatComposer } from "../pages/chat/components/chat-composer.tsx";
import { listStoredChatOutboxes } from "../pages/chat/composer-persistence.ts";
import {
  activeQueuedMessageEdit,
  beginQueuedMessageEdit,
  cancelQueuedMessageEdit,
  updateQueuedMessageEdit,
} from "../pages/chat/queued-message-edit.ts";
import {
  createGatewayRequestMock,
  type GatewayRequestMock,
} from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { mountOpenClawApp } from "./app-root.tsx";
import { resolveControlUiDocumentMode } from "./approval-deep-link.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext, ApplicationGateway } from "./context.ts";
import { GATEWAY_STORE_TEST_HELLO as HELLO } from "./gateway-store.test-support.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { loadSettings } from "./settings.ts";

// mock-isolation: Keep shell UI subscriptions out of the Gateway lineage and outbox fixture.
vi.mock("./app-host.tsx", () => ({
  OpenClawShell: () => document.createElement("openclaw-app-shell"),
}));

const mountedSurfaces: Array<() => void> = [];

function createGatewayHarness() {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  const clients: Array<{
    opts: GatewayBrowserClientOptions;
    request: GatewayRequestMock;
    recoveryScope: string | undefined;
    recoveryScopeReady: boolean;
  }> = [];
  const gateway = createApplicationGateway(loadSettings(), "", "", (opts) => {
    const client = {
      opts,
      instanceId: opts.instanceId,
      gatewayUrl: opts.url,
      recoveryScope: undefined as string | undefined,
      recoveryScopeReady: false,
      addEventListener: () => () => {},
      start: vi.fn(),
      stop: vi.fn(() => {
        client.recoveryScopeReady = false;
      }),
      request: createGatewayRequestMock(async (method: string) => {
        const replies: Record<string, unknown> = {
          "sessions.list": sessionsResult([], 1),
          "chat.startup": { messages: [] },
          "chat.history": { messages: [] },
          "chat.metadata": { models: [], commands: [] },
          "sessions.branches.list": { branches: [] },
        };
        return replies[method] ?? {};
      }),
    };
    clients.push(client);
    return client as unknown as GatewayBrowserClient;
  });
  return {
    gateway,
    clients,
    hello: (index = 0, hello = HELLO) => clients[index]!.opts.onHello?.(hello),
    close: (index = 0, reason = "login required", willRetry = true) =>
      clients[index]!.opts.onClose?.({ code: 1006, reason, willRetry }),
    recover: (scope: string, index = 0) => {
      Object.assign(clients[index]!, { recoveryScope: scope, recoveryScopeReady: true });
      clients[index]!.opts.onRecoveryScopeChange?.();
    },
    starting: (index = 0) =>
      clients[index]!.opts.onClose?.({
        code: 4013,
        reason: "gateway starting",
        willRetry: true,
        error: {
          code: "UNAVAILABLE",
          message: "gateway starting; retry shortly",
          details: { reason: "startup-sidecars" },
          retryable: true,
          retryAfterMs: 250,
        },
      }),
  };
}

async function settleRootContent(): Promise<void> {
  flush();
  await Promise.resolve();
  flush();
}

async function createGatewaySurface(
  gateway: ApplicationGateway,
  pathname = "/chat",
  pendingGatewayUrl: string | null = null,
) {
  const base = bootstrapApplication();
  const runtime: ApplicationRuntime = {
    ...base,
    context: { ...base.context, gateway },
    documentMode: resolveControlUiDocumentMode(pathname, ""),
    focusLocation: parseControlUiFocusLocation(pathname, ""),
    pendingGatewayConnection: pendingGatewayUrl
      ? { gatewayUrl: pendingGatewayUrl, token: null }
      : null,
    confirmPendingGatewayConnection: vi.fn(),
    cancelPendingGatewayConnection: vi.fn(),
    start: async () => {},
  };
  const container = document.createElement("openclaw-app");
  document.body.append(container);
  const dispose = mountOpenClawApp(container, runtime);
  mountedSurfaces.push(() => {
    dispose();
    container.remove();
  });
  await settleRootContent();
  return { runtime, container, draw: settleRootContent };
}

afterEach(async () => {
  for (const dispose of mountedSurfaces.splice(0)) {
    dispose();
  }
  // Standalone startup views load their panel registration while the splash is visible.
  await vi.dynamicImportSettled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Control UI Gateway target lineage", () => {
  it.each([
    { pathname: "/focus/dashboard/main", phase: "connecting" },
    { pathname: "/settings/connection", phase: "connecting" },
    { pathname: "/settings/connection", phase: "stopped" },
    { pathname: "/approve/pending", phase: "connected" },
  ])(
    "keeps Gateway confirmation actionable at $pathname while $phase",
    async ({ pathname, phase }) => {
      const { gateway, hello, close } = createGatewayHarness();
      gateway.start();
      if (phase === "connected") {
        hello();
      } else if (phase === "stopped") {
        close(0, "login required", false);
      }
      for (const action of ["onConfirm", "onCancel"] as const) {
        const pendingGatewayUrl = "wss://pending-gateway.example";
        const { runtime, container, draw } = await createGatewaySurface(
          gateway,
          pathname,
          pendingGatewayUrl,
        );
        await vi.dynamicImportSettled();
        await draw();
        const confirmations = container.querySelectorAll("openclaw-gateway-url-confirmation");
        expect(confirmations).toHaveLength(1);
        const confirmation = confirmations[0] as HTMLElement & {
          props: { pendingGatewayUrl: string; onConfirm(): void; onCancel(): void };
        };
        expect(confirmation.closest("openclaw-tooltip-provider")).not.toBeNull();
        expect(confirmation.props.pendingGatewayUrl).toBe(pendingGatewayUrl);
        if (pathname.startsWith("/approve/")) {
          expect(container.querySelector("openclaw-approval-page")).toBeNull();
        }
        confirmation.props[action]();
        await draw();
        expect(container.querySelector("openclaw-gateway-url-confirmation")).toBeNull();
        expect(
          action === "onConfirm"
            ? runtime.confirmPendingGatewayConnection
            : runtime.cancelPendingGatewayConnection,
        ).toHaveBeenCalledOnce();
      }
      gateway.stop();
    },
  );

  it.each([
    { incognito: false, nextRecovery: "synthetic-recovery-a" },
    { incognito: true, nextRecovery: "synthetic-recovery-b" },
  ])(
    "binds retained queue edits across recovery $nextRecovery (Incognito: $incognito)",
    async ({ incognito, nextRecovery }) => {
      vi.stubGlobal("requestIdleCallback", vi.fn());
      vi.stubGlobal("requestAnimationFrame", () => 1);
      vi.stubGlobal("cancelAnimationFrame", () => undefined);
      const { gateway, clients, hello: admit, close, recover } = createGatewayHarness();
      const sessionKey = "agent:main:main";
      const agentsList = {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      } satisfies AgentsListResult;
      const hello: GatewayHelloOk = {
        ...HELLO,
        auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
        snapshot: {
          sessionDefaults: { defaultAgentId: "main", mainKey: "main", mainSessionKey: sessionKey },
        },
      };
      gateway.connect({ gatewayUrl: "wss://synthetic-owner.example.test" });
      admit(0, hello);
      recover("synthetic-recovery-a");
      const sessions = createTestSessionCapability(gateway);
      const { pane, state } = createTestChatPane({ client: gateway.snapshot.client!, sessions });
      state.sessionKey = sessionKey;
      state.agentsList = agentsList;
      state.settings = { ...loadSettings(), gatewayUrl: gateway.connection.gatewayUrl, sessionKey };
      state.selectedChatSessionIncognito = incognito;
      state.loadAssistantIdentity = vi.fn(async () => undefined);
      pane.presented = false;
      pane.context = {
        ...pane.context,
        gateway,
        agents: { state: { agentsList }, ensureList: async () => agentsList },
      } as unknown as ApplicationContext;
      pane.applyGatewaySnapshot(gateway.snapshot);
      const releasePane = gateway.subscribe(pane.applyGatewaySnapshot.bind(pane));
      const releaseOutbox = chatOutboxOwner(state).subscribe(state);
      const { container: shellContainer, draw: drawShell } = await createGatewaySurface(gateway);
      await drawShell();
      await vi.dynamicImportSettled();
      await settleRootContent();
      const originalShell = shellContainer.querySelector("openclaw-app-shell");
      expect(originalShell).not.toBeNull();
      const releaseShell = gateway.subscribe(() => {
        void drawShell();
      });
      const composer = createComposerContainer();
      let unmountComposer: (() => void) | undefined;
      try {
        expect(
          admitQueuedMessageForSession(state, captureChatOutboxAdmission(state, sessionKey), {
            id: "owner-row",
            text: "Original queued message",
            createdAt: 1000,
            sessionKey,
            sendState: "waiting-reconnect",
          }),
        ).toBe(true);
        expect(beginQueuedMessageEdit(state, "owner-row")).toBe("started");
        const captured = state.chatQueuedEdit!;
        const initialClient = state.client;
        const outboxes = listStoredChatOutboxes(state);
        const originalScope = { settings: state.settings, client: initialClient };
        const originalTarget = storageTargetForComposer(state);
        const originalBytes = sessionStorage.getItem(originalTarget.key);
        expect(originalBytes).not.toBeNull();
        clients[0]!.recoveryScopeReady = false;
        close(0, "offline");
        expect(state.connected).toBe(false);
        expect(updateQueuedMessageEdit(state, "Unsaved offline correction")).toBe(true);
        expect(activeQueuedMessageEdit(state)).toBe(captured);
        gateway.connect();
        expect(gateway.snapshot.phase).toBe("reconnecting");
        await drawShell();
        expect(shellContainer.querySelector("openclaw-app-shell")).toBe(originalShell);
        // Hello alone cannot authorize access to the old owner's correction.
        admit(1, hello);
        expect.soft(activeQueuedMessageEdit(state)).toBeNull();
        expect.soft(cancelQueuedMessageEdit(state)).toBe(false);
        expect(beginQueuedMessageEdit(state, captured.id)).toBe("unavailable");
        recover(nextRecovery, 1);
        await vi.waitFor(() => expect(state.chatLoading).toBe(false));
        const sameOwner = nextRecovery === "synthetic-recovery-a";
        const active = activeQueuedMessageEdit(state);
        const props = createComposerProps({
          queue: state.chatQueue,
          sessionKey,
          queuedEdit: {
            editingId: active?.id ?? null,
            editingText: active?.draftText,
            source: active?.source,
            onCancel: () => cancelQueuedMessageEdit(state),
          },
        });
        unmountComposer = mountSolid(() => createComponent(ChatComposer, props), {
          container: composer,
        }).unmount;
        flush();
        if (!sameOwner) {
          await handleSendChat(state, captured.draftText, {
            resumeQueuedMessageEditId: captured.id,
            attachmentsOverride: captured.attachments,
          });
          expect(clients[1]!.request.mock.calls.map(([method]) => method)).not.toContain(
            "chat.send",
          );
        }
        // Account isolation preserves the original owner's unsent bytes.
        expect(listStoredChatOutboxes(state)).toEqual(sameOwner ? outboxes : []);
        expect(sessionStorage.getItem(originalTarget.key)).toBe(originalBytes);
        expect(listStoredChatOutboxes(originalScope)).toEqual(outboxes);
        expect(shellContainer.querySelector("openclaw-app-shell")).toBe(originalShell);
        expect(pane.state).toBe(state);
        expect(state.client).not.toBe(initialClient);
        expect.soft(Boolean(active)).toBe(sameOwner);
        const editInput = composer.querySelector<HTMLTextAreaElement>(".chat-queue__edit-input");
        expect.soft(editInput?.value ?? null).toBe(sameOwner ? captured.draftText : null);
        if (sameOwner) {
          const settings = state.settings;
          state.settings = { ...settings, gatewayUrl: "wss://different-owner.example.test" };
          expect(activeQueuedMessageEdit(state)).toBeNull();
          expect(cancelQueuedMessageEdit(state)).toBe(false);
          expect(state.chatQueuedEdit).toBe(captured);
          state.settings = settings;
        }
        expect.soft(cancelQueuedMessageEdit(state)).toBe(sameOwner);
        if (!sameOwner) {
          expect.soft(state.chatQueuedEdit).toBe(captured);
        }
      } finally {
        releaseShell();
        releasePane();
        releaseOutbox();
        unmountComposer?.();
        pane.disconnectedCallback();
        sessions.dispose();
        gateway.stop();
        await resetComposerFixture();
      }
    },
  );

  it("returns to the login gate when a newly selected Gateway's first attempt fails", async () => {
    const { gateway, hello, close } = createGatewayHarness();
    gateway.start();
    hello();
    gateway.connect({ gatewayUrl: "wss://other-gateway.example.test" });
    close(1, "remote refused");

    const { container } = await createGatewaySurface(gateway);
    expect(container.innerHTML).toContain("<openclaw-login-gate");
    expect(container.innerHTML).not.toContain("<openclaw-app-shell");
  });

  it("re-scopes credentials when the login draft changes Gateway", async () => {
    const { gateway, clients, close } = createGatewayHarness();
    gateway.connect({ token: "old-token", password: "old-password" });
    close();
    const { container } = await createGatewaySurface(gateway);
    const login = container.querySelector<LoginGateElement>("openclaw-login-gate")!;

    login.props!.onGatewayUrlChange("wss://other-gateway.example.test");
    await settleRootContent();
    login.props!.onConnect();

    expect([clients[1]?.opts.token, clients[1]?.opts.password]).toEqual([undefined, undefined]);
  });

  it("shows startup progress after a manual connection attempt", async () => {
    const { gateway, hello, close, starting } = createGatewayHarness();
    gateway.start();
    close(0, "manual connection required");
    const { container, draw } = await createGatewaySurface(gateway);
    const login = container.querySelector<LoginGateElement>("openclaw-login-gate")!;

    login.props!.onConnect();
    starting(1);
    await draw();

    expect(container.innerHTML).toContain("Gateway starting…");
    expect(container.innerHTML).not.toContain("<openclaw-login-gate");

    hello(1);
    await draw();
    await vi.dynamicImportSettled();
    await settleRootContent();
    expect(container.innerHTML).toContain("<openclaw-app-shell");
  });

  it.each(["desktop", "terminal"] as const)(
    "shows retryable Gateway startup in the standalone %s document",
    async (documentView) => {
      const { gateway, starting } = createGatewayHarness();
      gateway.start();
      starting();

      const { container } = await createGatewaySurface(gateway, `/focus/${documentView}`);
      expect(container.innerHTML).toContain('class="connect-splash connect-splash--skeleton"');
      expect(container.innerHTML).toContain("Gateway starting…");
    },
  );
});
