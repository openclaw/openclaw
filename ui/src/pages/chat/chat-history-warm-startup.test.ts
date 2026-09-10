/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createGatewayRequestMock } from "../../test-helpers/gateway-client.ts";
import {
  resetChatHistoryProjection,
  synchronizeInitialChatSnapshotConnection,
} from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  nativeHistoryMessage,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { refreshPageChat } from "./chat-state-refresh.ts";
import { resetTranscriptTestDom } from "./components/chat-transcript.test-support.ts";
import type { ChatMessageCache, ChatSessionSnapshot } from "./session-message-cache.ts";
import * as snapshotDatabase from "./session-snapshot-database.ts";
import { markPrewarmedChatSnapshotReady, prewarmChatSnapshot } from "./session-snapshot-prewarm.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
import "./chat-pane.ts";

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
) {
  const read = createDeferred<ChatSessionSnapshot | null>();
  const memory: ChatMessageCache = new Map();
  const store = snapshotStore ?? new SessionSnapshotStore(memory);
  if (!snapshotStore) {
    vi.spyOn(store, "read").mockReturnValue(read.promise);
  }
  const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
  panes.push(pane);
  vi.spyOn(pane, "requestUpdate").mockImplementation(() => undefined);
  vi.spyOn(pane, "performUpdate").mockImplementation(() => undefined);
  const context = createInitializationContext();
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
  expect(() => pane.connectedCallback()).toThrow(attached);
  const state = pane.state;
  const liveResult = {
    messages: liveMessages,
    sessionId: "warm-session",
    sessionInfo: { key, kind: "direct", sessionId: "warm-session", updatedAt: 1 },
    hasMore: false,
    deltaCursor: "live-cursor",
  };
  const request = createGatewayRequestMock(async () => liveResult);
  const client = createGatewayBrowserClientFixture({ request });
  return {
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
  it("waits for hydration after a long offline mount and shares the cursor startup between callers", async () => {
    const h = mountPane();
    await vi.advanceTimersByTimeAsync(1_000);
    h.connect();
    await vi.advanceTimersByTimeAsync(200);
    const first = h.start();
    const joined = h.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.request).not.toHaveBeenCalled();

    h.read.resolve(stored);
    await Promise.all([first, joined]);
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      "chat.startup",
      expect.objectContaining({ sessionKey, cursor: "stored-cursor" }),
    );
  });

  it("caps the wait at 300 ms from connection readiness and fences a late stored snapshot", async () => {
    const h = mountPane();
    const network = createDeferred<typeof h.liveResult>();
    h.request.mockReturnValueOnce(network.promise);
    await vi.advanceTimersByTimeAsync(1_000);
    h.connect();
    await vi.advanceTimersByTimeAsync(100);
    const loading = h.start();
    await vi.advanceTimersByTimeAsync(199);
    expect(h.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      "chat.startup",
      expect.not.objectContaining({ cursor: expect.anything() }),
    );
    expect(h.state.chatMessages).toEqual([]);

    h.read.resolve(stored);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.state.chatMessages).toEqual([]);
    network.resolve(h.liveResult);
    await loading;
    expect(h.state.chatMessages).toEqual(liveMessages);
    const refresh = h.start();
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.request).toHaveBeenLastCalledWith(
      "chat.startup",
      expect.objectContaining({ cursor: "live-cursor" }),
    );
    await refresh;
  });

  it("continues as soon as a pending read reports no stored snapshot", async () => {
    const h = mountPane();
    h.connect();
    const loading = h.start();
    expect(h.request).not.toHaveBeenCalled();
    h.read.resolve(null);
    await loading;
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      "chat.startup",
      expect.not.objectContaining({ cursor: expect.anything() }),
    );
  });

  it("observes startup at actual issuance after an ordinary history refresh during the wait", async () => {
    const h = mountPane();
    const during = {
      ...h.liveResult,
      sessionInfo: { ...h.liveResult.sessionInfo, label: "During hydration wait" },
    };
    const after = {
      ...h.liveResult,
      sessionInfo: { ...h.liveResult.sessionInfo, label: "After hydration wait" },
    };
    const { sessions } = connectSessionOwner(h, during, after);
    const historyMethods = () =>
      h.request.mock.calls
        .map(([method]) => method)
        .filter((method) => method === "chat.history" || method === "chat.startup");
    const startup = refreshPageChat(h.state, {
      historyLoad: h.start(),
      awaitHistory: true,
      scheduleScroll: false,
    });
    await refreshPageChat(h.state, {
      historyLoad: loadChatHistory(h.state, { deferBranches: true }),
      awaitHistory: true,
      scheduleScroll: false,
    });
    expect(h.request).toHaveBeenCalledExactlyOnceWith("chat.history", expect.anything());
    expect(sessions.state.result?.sessions[0]?.label).toBe(during.sessionInfo.label);
    await vi.advanceTimersByTimeAsync(299);
    expect(historyMethods()).toEqual(["chat.history"]);
    await vi.advanceTimersByTimeAsync(1);
    await startup;
    expect(historyMethods()).toEqual(["chat.history", "chat.startup"]);
    expect(h.request).toHaveBeenLastCalledWith(
      "chat.startup",
      expect.objectContaining({ cursor: "live-cursor" }),
    );
    expect(sessions.state.result?.sessions[0]?.label).toBe(after.sessionInfo.label);
    expect(h.state.chatMessages).toEqual(liveMessages);
    h.read.resolve(stored);
  });

  it("retires the prior session owner while the shared hydration wait is pending", async () => {
    const h = mountPane();
    const { gateway, sessions } = connectSessionOwner(h);
    const retired = h.start();
    await vi.advanceTimersByTimeAsync(100);
    const replacement = createTestSessionCapability(gateway);
    onTestFinished(() => replacement.dispose());
    h.state.sessions = replacement;
    const current = refreshPageChat(h.state, {
      historyLoad: h.start(),
      awaitHistory: true,
      scheduleScroll: false,
    });
    await vi.advanceTimersByTimeAsync(199);
    expect(h.request.mock.calls.filter(([method]) => method === "chat.startup")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(retired).resolves.toBeUndefined();
    await current;
    expect(h.request.mock.calls.filter(([method]) => method === "chat.startup")).toEqual([
      ["chat.startup", expect.anything()],
    ]);
    expect(sessions.state.result).toBeNull();
    expect(replacement.state.result?.sessions[0]).toMatchObject(h.liveResult.sessionInfo);
    expect(h.state.chatMessages).toEqual(liveMessages);
    h.read.resolve(stored);
  });

  it.each([
    ["main", "agent:main:main"],
    ["AGENT:MAIN:WARM-STARTUP", sessionKey],
  ])(
    "retains startup when %s becomes its canonical key %s during hydration",
    async (alias, canonical) => {
      const h = mountPane(true, canonical);
      h.state.sessionKey = alias;
      h.connect();
      const loading = h.start();
      h.state.sessionKey = canonical;
      h.read.resolve(stored);
      await loading;
      expect(h.request).toHaveBeenCalledExactlyOnceWith(
        "chat.startup",
        expect.objectContaining({ sessionKey: canonical, cursor: "stored-cursor" }),
      );
      expect(h.state.chatMessages).toEqual(liveMessages);
    },
  );

  it("does not defer startup when the pane has no stored read", async () => {
    const h = mountPane(false);
    h.connect();
    const loading = h.start();
    expect(h.request).toHaveBeenCalledOnce();
    await loading;
  });

  it("does not defer startup for a stored read begun after connection readiness", async () => {
    const h = mountPane(true, sessionKey, true);
    h.connect();
    const loading = h.start();
    expect(h.request).toHaveBeenCalledOnce();
    await loading;
    h.read.resolve(stored);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.chatMessages).toEqual(liveMessages);
  });

  it("waits for a boot prewarm consumed by a pane mounted after readiness", async () => {
    const record = createDeferred<unknown>();
    vi.spyOn(snapshotDatabase, "readStoredChatSnapshotRecord").mockReturnValueOnce(record.promise);
    prewarmChatSnapshot(sessionKey);
    markPrewarmedChatSnapshotReady();
    const h = mountPane(true, sessionKey, true, new SessionSnapshotStore());
    h.connect();
    const loading = h.start();
    expect(h.request).not.toHaveBeenCalled();
    record.resolve({
      savedAt: Date.now(),
      sessionKey,
      sessionId: stored.sessionId,
      snapshot: stored,
    });
    await loading;
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      "chat.startup",
      expect.objectContaining({ sessionKey, cursor: "stored-cursor" }),
    );
  });

  it("keeps the prewarm deadline anchored to hello when the pane mounts later", async () => {
    const record = createDeferred<unknown>();
    vi.spyOn(snapshotDatabase, "readStoredChatSnapshotRecord").mockReturnValueOnce(record.promise);
    prewarmChatSnapshot(sessionKey);
    await vi.advanceTimersByTimeAsync(50);
    markPrewarmedChatSnapshotReady();
    await vi.advanceTimersByTimeAsync(100);
    markPrewarmedChatSnapshotReady();
    const h = mountPane(true, sessionKey, true, new SessionSnapshotStore());
    h.connect();
    const loading = h.start();
    await vi.advanceTimersByTimeAsync(199);
    expect(h.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      "chat.startup",
      expect.not.objectContaining({ cursor: expect.anything() }),
    );
    await loading;
    record.resolve({
      savedAt: Date.now(),
      sessionKey,
      sessionId: stored.sessionId,
      snapshot: stored,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.chatMessages).toEqual(liveMessages);
  });

  it("starts immediately if the connection budget expired before startup was requested", async () => {
    const h = mountPane();
    h.connect();
    await vi.advanceTimersByTimeAsync(300);
    const loading = h.start();
    expect(h.request).toHaveBeenCalledOnce();
    await loading;
    h.read.resolve(stored);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.chatMessages).toEqual(liveMessages);
  });

  it.each(["disconnect", "reset"])(
    "retires the first wait on %s without delaying the next startup",
    async (transition) => {
      const h = mountPane();
      h.connect();
      const loading = h.start();
      if (transition === "disconnect") {
        h.state.connected = false;
        synchronizeInitialChatSnapshotConnection(h.state);
      } else {
        resetChatHistoryProjection(h.state);
      }
      await loading;
      expect(h.request).not.toHaveBeenCalled();
      h.connect();
      const retry = h.start();
      expect(h.request).toHaveBeenCalledOnce();
      await retry;
      h.read.resolve(stored);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.state.chatMessages).toEqual(liveMessages);
    },
  );
});
