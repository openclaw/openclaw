import { IDBFactory } from "fake-indexeddb";
import { createRoot } from "solid-js";
import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { observeChatCache, type ChatMessageCache } from "./session-message-cache.ts";
import { createSessionPrefetch } from "./session-prefetch.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";

export const PREFETCH_TEST_NOW = 1_000_000;
export const prefetchSnapshotHost = {
  settings: { gatewayUrl: "ws://test.invalid" },
  client: { recoveryScope: "test-recovery-scope", recoveryScopeReady: true },
  assistantAgentId: "main",
  agentsList: null,
  hello: null,
};

export type SessionPrefetchUpdate = {
  client: GatewayBrowserClient | null;
  listRevision: number;
  openSessionKeys: readonly string[];
  loadingSessionKeys?: readonly string[];
  hiddenConversationSessionKeys?: readonly string[];
  rows: readonly GatewaySessionRow[] | null;
};

export function prefetchState(
  request: GatewayRequestHandler,
  rows: SessionPrefetchUpdate["rows"],
  overrides: Partial<SessionPrefetchUpdate> = {},
): SessionPrefetchUpdate {
  return {
    client: createTestGatewayClient(request),
    listRevision: 1,
    openSessionKeys: ["agent:main:foreground"],
    rows,
    ...overrides,
  };
}

export function prefetchHistoryRequest() {
  return vi.fn(async (_method: string, params: unknown) =>
    prefetchHistoryResult(prefetchSessionKeyFromCall([_method, params])),
  );
}

export async function advanceSessionPrefetch(milliseconds = 300) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await settleSessionPrefetch();
}

export function prefetchSessionRow(
  key: string,
  activityAt: number | undefined,
  updatedAt = activityAt ?? 0,
): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    updatedAt,
    ...(activityAt === undefined ? {} : { lastActivityAt: activityAt }),
  };
}

export function prefetchHistoryResult(sessionKey: string) {
  return {
    completeSnapshot: true,
    messages: [{ role: "assistant", content: sessionKey }],
    sessionId: `id:${sessionKey}`,
  };
}

export function prefetchSessionKeyFromCall(call: unknown[]): string {
  return (call[1] as { sessionKey: string }).sessionKey;
}

export async function settleSessionPrefetch(): Promise<void> {
  for (let index = 0; index < 60; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await Promise.resolve();
  }
}

export function createSessionPrefetchFixture() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(PREFETCH_TEST_NOW);
  vi.stubGlobal("indexedDB", new IDBFactory());
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) =>
    window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0),
  );
  vi.stubGlobal("cancelIdleCallback", (handle: number) => window.clearTimeout(handle));
  const cache: ChatMessageCache = new Map();
  const store = new SessionSnapshotStore(cache);
  store.connect();
  observeChatCache(cache, store);
  let current: SessionPrefetchUpdate = {
    client: null,
    listRevision: 0,
    openSessionKeys: [],
    rows: null,
  };
  const connection = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  const context = {
    agents: { state: { agentsList: null } },
    gateway: {
      connection: { gatewayUrl: "ws://test.invalid" },
      get snapshot() {
        return { assistantAgentId: "main", hello: null, client: current.client };
      },
      subscribe: () => () => undefined,
    },
    sessions: {
      captureConnectionScope: connection.capture,
      isConnectionScopeCurrent: connection.isCurrent,
      subscribe: () => () => undefined,
      get canonicalListRevision() {
        return current.listRevision;
      },
      get state() {
        return { result: current.rows ? { sessions: current.rows } : null };
      },
    },
  };
  const host = document.createElement("div");
  const shell = document.createElement("openclaw-app-shell");
  shell.append(host);
  document.body.append(shell);
  let syncPrefetch: () => void;
  let unmountPrefetch: () => void;
  function mountPrefetch(): void {
    unmountPrefetch = createRoot((dispose) => {
      syncPrefetch = createSessionPrefetch(host, cache, store, () => context);
      return dispose;
    });
  }
  mountPrefetch();

  function updatePrefetch(update: SessionPrefetchUpdate): void {
    current = update;
    connection.transition({
      client: update.client,
      phase: update.client ? "connected" : "stopped",
    });
    host.replaceChildren(
      ...update.openSessionKeys.map((sessionKey) =>
        Object.assign(document.createElement("openclaw-chat-pane"), {
          sessionKey,
          conversationPresented:
            update.hiddenConversationSessionKeys?.includes(sessionKey) !== true,
          transcriptLoading: update.loadingSessionKeys?.includes(sessionKey) === true,
        }),
      ),
    );
    syncPrefetch();
  }

  return {
    cache,
    mountPrefetch,
    unmountPrefetch: () => unmountPrefetch(),
    store,
    host,
    shell,
    updatePrefetch,
    intend: (sessionKey: string, parent: Element = shell, eventType = "pointerover") => {
      const target = document.createElement("a");
      target.dataset.sessionKey = sessionKey;
      parent.append(target);
      target.dispatchEvent(new Event(eventType, { bubbles: true }));
      return target;
    },
    setVisibility: (value: DocumentVisibilityState) => {
      visibility = value;
    },
    dispose: async () => {
      unmountPrefetch();
      shell.remove();
      await store.flush();
      store.disconnect();
      await store.whenIdle();
      await clearStoredChatSnapshots();
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    },
  };
}
