/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSettings } from "../../app/settings.ts";
import { sessionProgressCardsForGateway } from "../../lib/session-progress-cards.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createGatewayRequestMock } from "../../test-helpers/gateway-client.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import {
  chatHistoryRequests,
  resetChatHistoryProjection,
  synchronizeInitialChatSnapshotConnection,
} from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createPaneTestHost,
  getPaneTestRuntime,
  nativeHistoryMessage,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { refreshPageChat } from "./chat-state-refresh.ts";
import { resetTranscriptTestDom } from "./components/chat-transcript.test-support.ts";
import {
  observeChatCache,
  readChatSessionSnapshot,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import * as snapshotDatabase from "./session-snapshot-database.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";
import { prewarmChatSnapshot } from "./session-snapshot-prewarm.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
import "./chat-pane.tsx";

const sessionKey = "agent:main:warm-startup";
const stored: ChatSessionSnapshot = {
  deltaCursor: "stored-cursor",
  messages: [nativeHistoryMessage(1, "Stored conversation")],
  pagination: { hasMore: false, completeSnapshot: true },
  sessionId: "warm-session",
};
const liveMessages = [nativeHistoryMessage(2, "Live conversation")];
const panes: TestChatPane[] = [];

function mountPane(
  withStore = true,
  key = sessionKey,
  connectedAtMount = false,
  snapshotStore?: SessionSnapshotStore,
  memory: ChatMessageCache = new Map(),
) {
  const read = createDeferred<ChatSessionSnapshot | null>();
  const store = snapshotStore ?? new SessionSnapshotStore(memory);
  if (!snapshotStore) {
    vi.spyOn(store, "read").mockReturnValue(read.promise);
  }
  // SAFETY: The fixture uses the real pane runtime and its forwarded test surface.
  const pane = createPaneTestHost(
    "openclaw-chat-runtime-test",
    ChatPaneRuntime,
  ) as unknown as TestChatPane;
  panes.push(pane);
  vi.spyOn(pane, "requestUpdate").mockImplementation(() => undefined);
  const context = createInitializationContext(
    createGatewayBrowserClientFixture({
      offlineRecoveryScope: "test-recovery-scope",
      recoveryScopeReady: false,
    }),
  );
  context.gateway.snapshot.phase = connectedAtMount ? "connected" : "connecting";
  pane.context = { ...context, sessions: createTestSessionCapability(context.gateway) };
  pane.sessionKey = key;
  pane.chatMessagesBySession = memory;
  if (withStore) {
    pane.sessionSnapshotStore = store;
  }
  const attached = new Error("pane state attached");
  vi.spyOn(pane.chatState, "attach").mockImplementation(() => {
    throw attached;
  });
  expect(() => getPaneTestRuntime(pane).start()).toThrow(attached);
  const state = pane.state;
  const liveResult = {
    messages: liveMessages,
    sessionId: "warm-session",
    sessionInfo: { key, kind: "direct", sessionId: "warm-session", updatedAt: 1 },
    hasMore: false,
    deltaCursor: "live-cursor",
  } satisfies ChatHistoryResult;
  const request = createGatewayRequestMock(async () => liveResult);
  const client = createGatewayBrowserClientFixture({ request });
  return {
    pane,
    client,
    state,
    read,
    request,
    liveResult,
    connect() {
      state.client = client;
      state.connected = true;
      state.connectionEpoch += 1;
      synchronizeInitialChatSnapshotConnection(state);
    },
    start() {
      return loadChatHistory(state, { startup: true, deferBranches: true });
    },
  };
}

function connectSessionOwner(
  h: ReturnType<typeof mountPane>,
  history = h.liveResult,
  startup = h.liveResult,
) {
  h.connect();
  h.request.mockImplementation(async (method) => {
    switch (method) {
      case "chat.history":
        return history;
      case "chat.startup":
        return startup;
      case "agent.identity.get":
      case "chat.metadata":
        return {};
      default:
        throw new Error(`Unexpected request: ${method}`);
    }
  });
  const { gateway } = createGatewayHarness(h.client);
  const sessions = createTestSessionCapability(gateway);
  h.state.sessions = sessions;
  onTestFinished(() => sessions.dispose());
  return { gateway, sessions };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  for (const pane of panes.splice(0)) {
    pane.disconnectedCallback();
    pane.context.sessions.dispose();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetTranscriptTestDom();
});

describe("first chat startup snapshot ordering", () => {
  it("rejects transcript and progress hydration when the Gateway account changes ahead of pane state", async () => {
    const h = mountPane();
    const progressCard = { sessionKey, revision: 2, updatedAt: 100, markdown: "Old account" };
    h.pane.context.gateway.snapshot.client = createGatewayBrowserClientFixture({
      offlineRecoveryScope: "another-account",
      recoveryScopeReady: false,
    });
    h.read.resolve({ ...stored, progressCard });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.chatMessages).toEqual([]);
    expect(
      sessionProgressCardsForGateway(h.pane.context.gateway).get({ sessionKey }),
    ).toBeUndefined();
  });

  it("hydrates progress with the stored transcript before hello", async () => {
    const h = mountPane();
    const progressCard = { sessionKey, revision: 2, updatedAt: 100, markdown: "Checking results" };
    h.read.resolve({ ...stored, progressCard });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.connected).toBe(false);
    expect(h.state.chatMessages).toEqual(stored.messages);
    expect(sessionProgressCardsForGateway(h.pane.context.gateway).get({ sessionKey })).toEqual(
      progressCard,
    );
    expect(h.request).not.toHaveBeenCalled();
  });
  it("issues startup immediately while the local snapshot is still pending", async () => {
    const h = mountPane();
    const network = createDeferred<typeof h.liveResult>();
    h.request.mockReturnValueOnce(network.promise);
    h.connect();
    const loading = h.start();
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      "chat.startup",
      expect.not.objectContaining({ cursor: expect.anything() }),
      { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
    );
    h.read.resolve(stored);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.chatMessages).toEqual(stored.messages);
    network.resolve(h.liveResult);
    await loading;
    expect(h.state.chatMessages).toEqual(liveMessages);
  });

  it.each(["cache-first", "history-first"] as const)(
    "retains the cached rows and widget heights for identical history (%s)",
    async (ordering) => {
      const memory: ChatMessageCache = new Map();
      const store = new SessionSnapshotStore(memory);
      observeChatCache(memory, store);
      const record = createDeferred<unknown>();
      vi.spyOn(snapshotDatabase, "readStoredChatSnapshotRecord").mockReturnValueOnce(
        record.promise,
      );
      const h = mountPane(true, sessionKey, false, store, memory);
      const network = createDeferred<ChatHistoryResult>();
      const snapshot = { ...stored, widgetHeights: { "inline-widget": 420 } };
      const paints: unknown[][] = [];
      h.state.requestUpdate = () => {
        if (h.state.chatMessages.length) {
          paints.push(h.state.chatMessages);
        }
      };
      h.request.mockReturnValueOnce(network.promise);
      h.connect();
      const loading = h.start();
      expect(h.request).toHaveBeenCalledOnce();
      const fresh = { ...h.liveResult, messages: structuredClone(stored.messages) };
      if (ordering === "history-first") {
        network.resolve(fresh);
        await vi.advanceTimersByTimeAsync(500);
        expect(h.state.chatMessages).toEqual([]);
      }
      record.resolve({
        projectionVersion: 3,
        savedAt: Date.now(),
        sessionKey: resolveChatSnapshotKey(h.state, { sessionKey }),
        sessionId: snapshot.sessionId,
        snapshot,
      });
      await vi.advanceTimersByTimeAsync(0);
      if (ordering === "cache-first") {
        network.resolve(fresh);
      }
      await loading;
      expect(paints.length).toBeGreaterThan(0);
      expect(paints.every((messages) => messages === paints[0])).toBe(true);
      expect(h.state.chatMessages).toBe(paints[0]);
      expect(h.state.chatMessages).toEqual(stored.messages);
      expect(readChatSessionSnapshot(memory, h.state, { sessionKey })?.widgetHeights).toEqual(
        snapshot.widgetHeights,
      );
    },
  );

  it("replaces changed bytes at the same native message identity", async () => {
    const h = mountPane();
    h.read.resolve(stored);
    await vi.advanceTimersByTimeAsync(0);
    const cachedMessage = h.state.chatMessages[0];
    const changedMessage = nativeHistoryMessage(1, "Updated conversation");
    h.request.mockResolvedValueOnce({ ...h.liveResult, messages: [changedMessage] });
    h.connect();
    await h.start();
    expect(h.state.chatMessages).toEqual([changedMessage]);
    expect(h.state.chatMessages[0]).not.toBe(cachedMessage);
  });

  it.each(["missing", "failed"] as const)(
    "publishes fresh history when the local read is %s",
    async (result) => {
      const h = mountPane();
      h.connect();
      const loading = h.start();
      expect(h.request).toHaveBeenCalledOnce();
      if (result === "missing") {
        h.read.resolve(null);
      } else {
        h.read.reject(new Error("Cache unavailable"));
      }
      await loading;
      expect(h.state.chatMessages).toEqual(liveMessages);
    },
  );

  it.each(["never settles", "settles late"] as const)(
    "publishes history after its cache grace period when the snapshot read %s",
    async (settlement) => {
      const h = mountPane();
      const network = createDeferred<typeof h.liveResult>();
      h.request.mockReturnValueOnce(network.promise);
      h.connect();
      const loading = h.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.state.chatMessages).toEqual([]);
      network.resolve(h.liveResult);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(h.state.chatMessages).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.state.chatMessages).toEqual(liveMessages);
      await loading;
      if (settlement === "settles late") {
        h.read.resolve(stored);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.state.chatMessages).toEqual(liveMessages);
      }
      expect(h.request).toHaveBeenCalledOnce();
    },
  );

  it("uses the cursor when the local read completed before startup", async () => {
    const h = mountPane();
    h.read.resolve(stored);
    await vi.advanceTimersByTimeAsync(0);
    h.connect();
    await h.start();
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      "chat.startup",
      expect.objectContaining({ sessionKey, cursor: "stored-cursor" }),
      { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
    );
  });

  it("shares the restored cursor request when the cache settles during stream admission", async () => {
    const h = mountPane();
    const admission = createDeferred<boolean>();
    chatHistoryRequests(h.state).subscriptionReady = admission.promise;
    const delta = {
      kind: "delta" as const,
      messages: [],
      sessionInfo: h.liveResult.sessionInfo,
      deltaCursor: "live-cursor",
    };
    const response = createDeferred<typeof delta>();
    h.request.mockReturnValueOnce(response.promise);
    h.connect();
    const loading = h.start();
    h.read.resolve(stored);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.chatMessages).toEqual(stored.messages);
    expect(h.request).not.toHaveBeenCalled();
    admission.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      "chat.startup",
      expect.objectContaining({ sessionKey, cursor: "stored-cursor" }),
      { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
    );
    const shared = h.start();
    response.resolve(delta);
    await Promise.all([loading, shared]);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.state.chatMessages).toEqual(stored.messages);
  });

  it("shares an immediate startup between callers while the local read is pending", async () => {
    const h = mountPane();
    h.connect();
    const first = h.start();
    const joined = h.start();
    expect(h.request).toHaveBeenCalledOnce();
    h.read.resolve(stored);
    await Promise.all([first, joined]);
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.state.chatMessages).toEqual(liveMessages);
  });

  it.each(["unchanged", "refreshed"] as const)(
    "hydrates both splits when shared history is %s",
    async (ordering) => {
      const memory: ChatMessageCache = new Map();
      const store = new SessionSnapshotStore(memory);
      const firstRead = createDeferred<ChatSessionSnapshot | null>();
      const secondRead = createDeferred<ChatSessionSnapshot | null>();
      vi.spyOn(store, "read")
        .mockReturnValueOnce(firstRead.promise)
        .mockReturnValueOnce(secondRead.promise);
      const first = mountPane(true, sessionKey, false, store, memory);
      const second = mountPane(true, sessionKey, false, store, memory);
      const { sessions } = connectSessionOwner(first);
      second.connect();
      second.state.client = first.client;
      second.state.sessions = sessions;
      const messages = ordering === "unchanged" ? structuredClone(stored.messages) : liveMessages;
      first.request.mockImplementation(async () => ({ ...first.liveResult, messages }));
      const loading = [first.start(), second.start()];
      firstRead.resolve(stored);
      await loading[0];
      secondRead.resolve(null);
      await Promise.all(loading);
      expect(first.state.chatMessages).toEqual(messages);
      expect(second.state.chatMessages).toEqual(messages);
      expect(readChatSessionSnapshot(memory, second.state, { sessionKey })?.messages).toEqual(
        messages,
      );
    },
  );

  it("retires the prior session capability while its response waits for cache", async () => {
    const h = mountPane();
    const { gateway, sessions } = connectSessionOwner(h);
    const retired = h.start();
    await vi.advanceTimersByTimeAsync(0);
    const replacement = createTestSessionCapability(gateway);
    onTestFinished(() => replacement.dispose());
    h.state.sessions = replacement;
    const current = refreshPageChat(h.state, {
      historyLoad: h.start(),
      awaitHistory: true,
      scheduleScroll: false,
    });
    h.read.resolve(stored);
    await expect(retired).resolves.toBeUndefined();
    await current;
    expect(sessions.state.result).toBeNull();
    expect(replacement.state.result?.sessions[0]).toMatchObject(h.liveResult.sessionInfo);
    expect(h.state.chatMessages).toEqual(liveMessages);
  });

  it("hydrates a boot prewarm consumed by a pane mounted after readiness", async () => {
    const record = createDeferred<unknown>();
    vi.spyOn(snapshotDatabase, "readStoredChatSnapshotRecord").mockReturnValueOnce(record.promise);
    prewarmChatSnapshot(
      resolveChatSnapshotKey(
        { settings: loadSettings(), client: { offlineRecoveryScope: "test-recovery-scope" } },
        { sessionKey },
      ),
    );
    const h = mountPane(true, sessionKey, true, new SessionSnapshotStore());
    h.connect();
    const loading = h.start();
    expect(h.request).toHaveBeenCalledOnce();
    record.resolve({
      projectionVersion: 3,
      savedAt: Date.now(),
      sessionKey: resolveChatSnapshotKey(h.state, { sessionKey }),
      sessionId: stored.sessionId,
      snapshot: stored,
    });
    await loading;
    expect(h.state.chatMessages).toEqual(liveMessages);
  });

  it.each(["disconnect", "reset", "session-switch"] as const)(
    "retires cache and history publication on %s",
    async (transition) => {
      const h = mountPane();
      h.connect();
      const loading = h.start();
      await vi.advanceTimersByTimeAsync(0);
      if (transition === "disconnect") {
        h.state.connected = false;
        synchronizeInitialChatSnapshotConnection(h.state);
      } else if (transition === "reset") {
        resetChatHistoryProjection(h.state);
      } else {
        h.state.sessionKey = "agent:main:another-session";
        resetChatHistoryProjection(h.state);
      }
      await expect(loading).resolves.toBeUndefined();
      h.read.resolve(stored);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.state.chatMessages).toEqual([]);
      h.connect();
      await h.start();
      expect(h.state.chatMessages).toEqual(liveMessages);
    },
  );
});
