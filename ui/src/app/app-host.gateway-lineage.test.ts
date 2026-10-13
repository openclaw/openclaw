import { parseControlUiFocusLocation } from "@openclaw/session-url-contract";
import { render } from "lit";
import { flush } from "solid-js";
/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayBrowserClient,
  GatewayBrowserClientOptions,
  GatewayHelloOk,
} from "../api/gateway.ts";
import type { AgentsListResult } from "../api/types.ts";
// These direct-render fixtures exercise Gateway lineage without the app lifecycle.
// Browser tests cover deferred login loading and recovery.
import "../components/login-gate.ts";
import { captureChatOutboxAdmission, storageTargetForComposer } from "../lib/chat/outbox-store.ts";
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
import { renderChatComposer } from "../pages/chat/components/chat-composer.tsx";
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
import { createStorageMock } from "../test-helpers/storage.ts";
import { mountOpenClawApp } from "./app-root.tsx";
import { resolveControlUiDocumentMode } from "./approval-deep-link.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext, ApplicationGateway } from "./context.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { loadSettings } from "./settings.ts";

// mock-isolation: Keep shell UI subscriptions out of the Gateway lineage and outbox fixture.
vi.mock("./app-host.tsx", () => ({
  OpenClawShell: () => document.createElement("openclaw-app-shell"),
}));

const mountedSurfaces: Array<() => void> = [];

const HELLO: GatewayHelloOk = {
  type: "hello-ok",
  protocol: 1,
  auth: { role: "operator", scopes: [] },
};

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
        if (method === "sessions.list") {
          return sessionsResult([], 1);
        }
        if (method === "chat.startup" || method === "chat.history") {
          return { messages: [] };
        }
        if (method === "chat.metadata") {
          return { models: [], commands: [] };
        }
        if (method === "sessions.branches.list") {
          return { branches: [] };
        }
        return {};
      }),
    };
    clients.push(client);
    return client as unknown as GatewayBrowserClient;
  });
  return { gateway, clients };
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
  const draw = settleRootContent;
  await draw();
  return { runtime, container, draw };
}

async function renderGatewaySurface(
  gateway: ApplicationGateway,
  documentView?: "desktop" | "terminal",
): Promise<string> {
  const surface = await createGatewaySurface(
    gateway,
    documentView ? `/focus/${documentView}` : undefined,
  );
  return surface.container.innerHTML;
}

afterEach(() => {
  for (const dispose of mountedSurfaces.splice(0)) {
    dispose();
  }
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
      const { gateway, clients } = createGatewayHarness();
      gateway.start();
      if (phase === "connected") {
        clients[0]!.opts.onHello?.(HELLO);
      } else if (phase === "stopped") {
        clients[0]!.opts.onClose?.({ code: 1006, reason: "login required", willRetry: false });
      }
      for (const action of ["onConfirm", "onCancel"] as const) {
        const pendingGatewayUrl = "wss://pending-gateway.example";
        const { runtime, container, draw } = await createGatewaySurface(
          gateway,
          pathname,
          pendingGatewayUrl,
        );
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
      const { gateway, clients } = createGatewayHarness();
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
      clients[0]!.opts.onHello?.(hello);
      clients[0]!.recoveryScope = "synthetic-recovery-a";
      clients[0]!.recoveryScopeReady = true;
      clients[0]!.opts.onRecoveryScopeChange?.();
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
        // Socket loss invalidates readiness but retains this client's authenticated owner.
        clients[0]!.recoveryScopeReady = false;
        clients[0]!.opts.onClose?.({ code: 1006, reason: "offline", willRetry: true });
        expect(state.connected).toBe(false);
        expect(updateQueuedMessageEdit(state, "Unsaved offline correction")).toBe(true);
        expect(activeQueuedMessageEdit(state)).toBe(captured);
        gateway.connect();
        expect(gateway.snapshot.phase).toBe("reconnecting");
        await drawShell();
        expect(shellContainer.querySelector("openclaw-app-shell")).toBe(originalShell);
        // Hello precedes recovery resolution. Neither a replacement transport nor
        // pending authentication can act on the old owner's retained correction.
        clients[1]!.opts.onHello?.(hello);
        expect.soft(activeQueuedMessageEdit(state)).toBeNull();
        expect.soft(cancelQueuedMessageEdit(state)).toBe(false);
        expect(beginQueuedMessageEdit(state, captured.id)).toBe("unavailable");
        clients[1]!.recoveryScope = nextRecovery;
        clients[1]!.recoveryScopeReady = true;
        clients[1]!.opts.onRecoveryScopeChange?.();
        await vi.waitFor(() => expect(state.chatLoading).toBe(false));
        const sameOwner = nextRecovery === "synthetic-recovery-a";
        const active = activeQueuedMessageEdit(state);
        render(
          renderChatComposer(
            createComposerProps({
              queue: state.chatQueue,
              sessionKey,
              queuedEdit: {
                editingId: active?.id ?? null,
                editingText: active?.draftText,
                source: active?.source,
                onCancel: () => cancelQueuedMessageEdit(state),
              },
            }),
          ),
          composer,
        );
        if (!sameOwner) {
          await handleSendChat(state, captured.draftText, {
            resumeQueuedMessageEditId: captured.id,
            attachmentsOverride: captured.attachments,
          });
          expect(clients[1]!.request.mock.calls.some(([method]) => method === "chat.send")).toBe(
            false,
          );
        }
        // The new account cannot project the old input, but its owner retains
        // the exact unsent bytes, including Incognito queued submissions.
        expect(listStoredChatOutboxes(state)).toEqual(sameOwner ? outboxes : []);
        expect(sessionStorage.getItem(originalTarget.key)).toBe(originalBytes);
        expect(listStoredChatOutboxes(originalScope)).toEqual(outboxes);
        expect(shellContainer.querySelector("openclaw-app-shell")).toBe(originalShell);
        expect(pane.state).toBe(state);
        expect(state.client).not.toBe(initialClient);
        expect.soft(Boolean(active)).toBe(sameOwner);
        expect
          .soft(
            composer.querySelector<HTMLTextAreaElement>(".chat-queue__edit-input")?.value ?? null,
          )
          .toBe(sameOwner ? captured.draftText : null);
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
        render(null, composer);

        pane.disconnectedCallback();
        sessions.dispose();
        gateway.stop();
        await resetComposerFixture();
      }
    },
  );

  it("returns to the login gate when a newly selected Gateway's first attempt fails", async () => {
    const { gateway, clients } = createGatewayHarness();
    gateway.start();
    clients[0]?.opts.onHello?.(HELLO);
    gateway.connect({ gatewayUrl: "wss://other-gateway.example.test" });
    clients[1]?.opts.onClose?.({ code: 1006, reason: "remote refused", willRetry: true });

    const surface = await renderGatewaySurface(gateway);

    expect(surface).toContain("<openclaw-login-gate");
    expect(surface).not.toContain("<openclaw-app-shell");
  });

  it("re-scopes credentials when the login draft changes Gateway", async () => {
    const { gateway, clients } = createGatewayHarness();
    gateway.connect({ token: "old-token", password: "old-password" });
    clients[0]?.opts.onClose?.({ code: 1006, reason: "login required", willRetry: true });
    const { container } = await createGatewaySurface(gateway);
    const loginGate = container.querySelector("openclaw-login-gate") as unknown as {
      props: {
        onGatewayUrlChange: (value: string) => void;
        onConnect: () => void;
      };
    };

    loginGate.props.onGatewayUrlChange("wss://other-gateway.example.test");
    await settleRootContent();
    loginGate.props.onConnect();

    expect(clients[1]?.opts.token).toBeUndefined();
    expect(clients[1]?.opts.password).toBeUndefined();
  });

  it("shows startup progress after a manual connection attempt", async () => {
    const { gateway, clients } = createGatewayHarness();
    gateway.start();
    clients[0]?.opts.onClose?.({
      code: 1006,
      reason: "manual connection required",
      willRetry: true,
    });
    const { container, draw } = await createGatewaySurface(gateway);
    const loginGate = container.querySelector("openclaw-login-gate") as unknown as {
      props: { onConnect: () => void };
    };

    loginGate.props.onConnect();
    clients[1]?.opts.onClose?.({
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
    });
    await draw();

    expect(container.innerHTML).toContain("Gateway starting…");
    expect(container.innerHTML).not.toContain("<openclaw-login-gate");

    clients[1]?.opts.onHello?.(HELLO);
    await draw();
    await vi.dynamicImportSettled();
    await settleRootContent();
    expect(container.innerHTML).toContain("<openclaw-app-shell");
  });

  it.each(["desktop", "terminal"] as const)(
    "shows retryable Gateway startup in the standalone %s document",
    async (documentView) => {
      const { gateway, clients } = createGatewayHarness();
      gateway.start();
      clients[0]?.opts.onClose?.({
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
      });

      const surface = await renderGatewaySurface(gateway, documentView);

      expect(surface).toContain('class="connect-splash connect-splash--skeleton"');
      expect(surface).toContain("Gateway starting…");
    },
  );
});
