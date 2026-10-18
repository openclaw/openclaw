/* @vitest-environment jsdom */
import { createEffect, createRoot, flush } from "@solidjs/signals";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSettings } from "../../app/settings.ts";
import { parseSlashCommand, SLASH_COMMANDS } from "../../lib/chat/commands.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
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
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { refreshChatCommands, refreshPageChat } from "./chat-state-refresh.ts";
import { resetTranscriptTestDom } from "./components/chat-transcript.test-support.ts";
import {
  observeChatCache,
  cacheChatSessionSnapshot,
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
  it("hydrates the local snapshot before issuing startup", async () => {
    const h = mountPane();
    const network = createDeferred<typeof h.liveResult>();
    h.request.mockReturnValueOnce(network.promise);
    h.connect();
    const loading = h.start();
    expect(h.request).not.toHaveBeenCalled();
    h.read.resolve(stored);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      "chat.startup",
      expect.objectContaining({ cursor: "stored-cursor" }),
      { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
    );
    expect(h.state.chatMessages).toEqual(stored.messages);
    network.resolve(h.liveResult);
    await loading;
    expect(h.state.chatMessages).toEqual(liveMessages);
  });

  it("retains the cached rows and widget heights for identical history", async () => {
    const memory: ChatMessageCache = new Map();
    const store = new SessionSnapshotStore(memory);
    observeChatCache(memory, store);
    const record = createDeferred<unknown>();
    vi.spyOn(snapshotDatabase, "readStoredChatSnapshotRecord").mockReturnValueOnce(record.promise);
    const h = mountPane(true, sessionKey, false, store, memory);
    const network = createDeferred<ChatHistoryResult>();
    const snapshot = { ...stored, widgetHeights: { "inline-widget": 420 } };
    const paints: unknown[][] = [];
    const dispose = createRoot((stop) => {
      const run = projectOwner(chatRunPresentation(h.state), (owner) => owner.values);
      createEffect(
        () => run.read().chatMessages,
        (messages) => {
          if (messages?.length) {
            paints.push(messages);
          }
        },
      );
      return stop;
    });
    onTestFinished(dispose);
    flush();
    h.request.mockReturnValueOnce(network.promise);
    h.connect();
    const loading = h.start();
    expect(h.request).not.toHaveBeenCalled();
    const fresh = { ...h.liveResult, messages: structuredClone(stored.messages) };
    record.resolve({
      projectionVersion: 3,
      savedAt: Date.now(),
      sessionKey: resolveChatSnapshotKey(h.state, { sessionKey }),
      sessionId: snapshot.sessionId,
      snapshot,
    });
    await vi.advanceTimersByTimeAsync(0);
    network.resolve(fresh);
    await loading;
    flush();
    expect(paints.length).toBeGreaterThan(0);
    expect(paints.every((messages) => messages === paints[0])).toBe(true);
    expect(h.state.chatMessages).toBe(paints[0]);
    expect(h.state.chatMessages).toEqual(stored.messages);
    expect(readChatSessionSnapshot(memory, h.state, { sessionKey })?.widgetHeights).toEqual(
      snapshot.widgetHeights,
    );
  });

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
      expect(h.request).not.toHaveBeenCalled();
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
      await vi.advanceTimersByTimeAsync(1_999);
      expect(h.request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.request).toHaveBeenCalledExactlyOnceWith(
        "chat.startup",
        expect.not.objectContaining({ cursor: expect.anything() }),
        expect.anything(),
      );
      network.resolve(h.liveResult);
      await loading;
      expect(h.state.chatMessages).toEqual(liveMessages);
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
    expect(h.request.mock.calls[0]?.[1]).toMatchObject({ knownState: {} });
  });

  it.each(["unchanged", "changed", "empty", "replacement"] as const)(
    "restores only receipt-matched warm metadata when server state is %s",
    async (change) => {
      const initial = mountPane();
      const pendingInputs = {
        items: [
          {
            id: "followup-1",
            runId: "run-followup-1",
            message: { role: "user", content: "Check the attachment before continuing." },
            acceptedAt: 1,
            state: "queued" as const,
            queued: true as const,
          },
        ],
        total: 1,
        queuedCount: 1,
      };
      const commands = [
        {
          name: "fixture_skill",
          description: "Run the fixture skill",
          source: "skill" as const,
          scope: "text" as const,
          acceptsArgs: true,
        },
      ];
      const stateRevision = {
        pendingInputs: "pending-1",
        sessionInfo: "session-1",
        commands: "commands-1",
      };
      const initialInfo = { ...initial.liveResult.sessionInfo, snapshotAt: 100 };
      initial.read.resolve(null);
      initial.request.mockResolvedValueOnce({
        ...initial.liveResult,
        pendingInputs,
        stateRevision,
        sessionInfo: initialInfo,
        metadata: { commands },
      });
      initial.connect();
      await initial.start();
      const snapshot = readChatSessionSnapshot(
        initial.state.chatMessagesBySession!,
        initial.state,
        {
          sessionKey,
        },
      );
      expect(snapshot?.historyState).toEqual({
        stateRevision,
        pendingInputs,
        sessionInfo: initialInfo,
        commands,
      });

      const warm = mountPane();
      warm.read.resolve(snapshot);
      await vi.advanceTimersByTimeAsync(0);
      const response = createDeferred<unknown>();
      warm.request.mockImplementation(async (method) =>
        method === "chat.startup" ? response.promise : { models: [] },
      );
      warm.connect();
      const loading = refreshPageChat(warm.state, {
        startup: true,
        awaitHistory: true,
        deferBranches: true,
      });
      expect(warm.request).toHaveBeenCalledWith(
        "chat.startup",
        expect.objectContaining({ cursor: "live-cursor", knownState: stateRevision }),
        expect.anything(),
      );

      const emptyInputs = { items: [], total: 0, queuedCount: 0 };
      const nextInputs =
        change === "unchanged"
          ? pendingInputs
          : change === "changed"
            ? {
                ...pendingInputs,
                items: [
                  {
                    ...pendingInputs.items[0]!,
                    message: { role: "user", content: "Updated followup." },
                  },
                ],
              }
            : emptyInputs;
      const nextInfo =
        change === "replacement"
          ? { ...warm.liveResult.sessionInfo, sessionId: "replacement-session", snapshotAt: 200 }
          : { ...warm.liveResult.sessionInfo, snapshotAt: 200 };
      const nextRevision =
        change === "unchanged"
          ? stateRevision
          : {
              pendingInputs: "pending-2",
              sessionInfo: change === "replacement" ? "session-2" : "session-1",
              commands: change === "changed" || change === "empty" ? "commands-2" : "commands-1",
            };
      const nextCommands =
        change === "empty"
          ? []
          : change === "changed"
            ? [{ ...commands[0]!, name: "replacement_skill" }]
            : commands;
      const metadata =
        nextRevision.commands === stateRevision.commands ? {} : { commands: nextCommands };
      // A sibling may publish a newer cache while this request still owns its earlier receipts.
      if (snapshot) {
        cacheChatSessionSnapshot(
          warm.state.chatMessagesBySession!,
          warm.state,
          { sessionKey },
          {
            ...snapshot,
            historyState: {
              stateRevision: nextRevision,
              pendingInputs: emptyInputs,
              sessionInfo: nextInfo,
            },
          },
        );
      }
      response.resolve({
        metadata,
        ...(change === "replacement"
          ? {
              ...warm.liveResult,
              sessionInfo: nextInfo,
              pendingInputs: nextInputs,
              stateRevision: nextRevision,
            }
          : {
              kind: "delta",
              messages: [],
              deltaCursor: "next-cursor",
              stateRevision: nextRevision,
              sessionInfoSnapshotAt: nextInfo.snapshotAt,
              ...(change === "unchanged" ? {} : { pendingInputs: nextInputs }),
            }),
      });
      await loading;
      await refreshChatCommands(warm.state);
      expect(warm.request.mock.calls.some(([method]) => method === "commands.list")).toBe(false);
      expect(SLASH_COMMANDS.some((command) => command.name === "fixture_skill")).toBe(
        nextCommands === commands,
      );
      expect(SLASH_COMMANDS.some((command) => command.name === "replacement_skill")).toBe(
        change === "changed",
      );
      if (nextCommands.length) {
        expect(parseSlashCommand(`/${nextCommands[0]!.name} fixture argument`)).toMatchObject({
          command: { name: nextCommands[0]!.name },
          args: "fixture argument",
        });
      }
      expect(warm.state.chatPendingInputs?.page).toEqual(nextInputs);
      expect(warm.state.chatPendingInputs?.queuedInputs).toEqual(nextInputs.items);
      expect(warm.state.currentSessionId).toBe(nextInfo.sessionId);
      expect(
        readChatSessionSnapshot(warm.state.chatMessagesBySession!, warm.state, { sessionKey })
          ?.historyState,
      ).toEqual({
        stateRevision: nextRevision,
        pendingInputs: nextInputs,
        sessionInfo: nextInfo,
        commands: nextCommands,
      });
    },
  );

  it("does not advertise a command revision without the retained catalog", async () => {
    const h = mountPane();
    h.read.resolve({ ...stored, historyState: { stateRevision: { commands: "commands-1" } } });
    await vi.advanceTimersByTimeAsync(0);
    h.connect();
    await h.start();
    expect(h.request).toHaveBeenCalledWith(
      "chat.startup",
      expect.objectContaining({ cursor: "stored-cursor", knownState: {} }),
      expect.anything(),
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

  it("keeps simultaneous startup requests with different metadata receipts separate", async () => {
    const first = mountPane();
    const second = mountPane();
    const emptyInputs = { items: [], total: 0, queuedCount: 0 };
    for (const [index, pane] of [first, second].entries()) {
      pane.read.resolve(null);
      pane.connect();
      pane.request.mockResolvedValueOnce({
        ...pane.liveResult,
        pendingInputs: emptyInputs,
        stateRevision: { pendingInputs: "empty", sessionInfo: `info-${index}` },
        sessionInfo: { ...pane.liveResult.sessionInfo, label: `Label ${index}` },
      });
      await pane.start();
    }
    second.state.client = first.client;
    second.state.sessions = first.state.sessions;
    const response = createDeferred<unknown>();
    first.request.mockClear();
    first.request.mockReturnValue(response.promise);
    const loads = [first.start(), second.start()];
    expect(first.request).toHaveBeenCalledTimes(2);
    expect(first.request.mock.calls.map(([, params]) => params)).toEqual([
      expect.objectContaining({ knownState: { pendingInputs: "empty", sessionInfo: "info-0" } }),
      expect.objectContaining({ knownState: { pendingInputs: "empty", sessionInfo: "info-1" } }),
    ]);
    response.resolve({
      kind: "delta",
      messages: [],
      deltaCursor: "next-cursor",
      sessionInfo: { ...first.liveResult.sessionInfo, label: "Latest label" },
      stateRevision: { pendingInputs: "empty", sessionInfo: "latest-info" },
    });
    await Promise.all(loads);
    expect(first.state.chatPendingInputs?.page).toEqual(emptyInputs);
    expect(second.state.chatPendingInputs?.page).toEqual(emptyInputs);
  });

  it("requests missing pending inputs separately even when cached receipts match", async () => {
    const initial = mountPane();
    const pendingInputs = {
      items: [
        {
          id: "followup-1",
          runId: "run-followup-1",
          message: { role: "user", content: "Check the attachment." },
          acceptedAt: 1,
          state: "queued" as const,
          queued: true as const,
        },
      ],
      total: 1,
      queuedCount: 1,
    };
    const stateRevision = { pendingInputs: "pending-1", sessionInfo: "info-1" };
    initial.read.resolve(null);
    initial.connect();
    initial.request.mockResolvedValueOnce({ ...initial.liveResult, pendingInputs, stateRevision });
    await initial.start();
    const snapshot = readChatSessionSnapshot(initial.state.chatMessagesBySession!, initial.state, {
      sessionKey,
    });
    if (!snapshot?.historyState) {
      throw new Error("expected cached startup metadata");
    }
    const first = mountPane();
    const second = mountPane();
    first.read.resolve(snapshot);
    second.read.resolve({
      ...snapshot,
      historyState: { stateRevision, sessionInfo: snapshot.historyState.sessionInfo },
    });
    await vi.advanceTimersByTimeAsync(0);
    first.connect();
    second.connect();
    second.state.client = first.client;
    second.state.sessions = first.state.sessions;
    const omitted = createDeferred<unknown>();
    const full = createDeferred<unknown>();
    first.request.mockReturnValueOnce(omitted.promise).mockReturnValueOnce(full.promise);
    const loads = [first.start(), second.start()];
    expect(first.request).toHaveBeenCalledTimes(2);
    expect(first.request.mock.calls.map(([, params]) => params)).toEqual([
      expect.objectContaining({ knownState: stateRevision }),
      expect.objectContaining({ knownState: { sessionInfo: "info-1" } }),
    ]);
    const delta = {
      kind: "delta",
      messages: [],
      deltaCursor: "next-cursor",
      stateRevision,
      sessionInfoSnapshotAt: 2,
    };
    omitted.resolve(delta);
    full.resolve({ ...delta, pendingInputs });
    await Promise.all(loads);
    expect(first.state.chatPendingInputs?.queuedInputs).toEqual(pendingInputs.items);
    expect(second.state.chatPendingInputs?.queuedInputs).toEqual(pendingInputs.items);
  });

  it("shares startup between callers while the local read is pending", async () => {
    const h = mountPane();
    h.connect();
    const first = h.start();
    const joined = h.start();
    expect(h.request).not.toHaveBeenCalled();
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

  it("retires the prior session capability while its request waits for cache", async () => {
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

  it("sends retained cursor and receipts when the pane mounts after readiness", async () => {
    const record = createDeferred<unknown>();
    vi.spyOn(snapshotDatabase, "readStoredChatSnapshotRecord").mockReturnValueOnce(record.promise);
    prewarmChatSnapshot(
      resolveChatSnapshotKey(
        { settings: loadSettings(), client: { offlineRecoveryScope: "test-recovery-scope" } },
        { sessionKey },
      ),
    );
    // Boot reads before the deferred pane mounts; hello and stream admission
    // need not leave another task for the pane's asynchronous hydration.
    await vi.advanceTimersByTimeAsync(16);
    const h = mountPane(true, sessionKey, true, new SessionSnapshotStore());
    const stateRevision = {
      pendingInputs: "pending-1",
      sessionInfo: "session-1",
      commands: "commands-1",
    };
    const historyState = {
      stateRevision,
      pendingInputs: { items: [], total: 0, queuedCount: 0 },
      sessionInfo: h.liveResult.sessionInfo,
      commands: [],
    };
    h.request.mockResolvedValueOnce({
      kind: "delta",
      messages: [],
      deltaCursor: "live-cursor",
      stateRevision,
      metadata: {},
    });
    h.connect();
    const loading = h.start();
    expect(h.request).not.toHaveBeenCalled();
    record.resolve({
      projectionVersion: 3,
      savedAt: Date.now(),
      sessionKey: resolveChatSnapshotKey(h.state, { sessionKey }),
      sessionId: stored.sessionId,
      snapshot: { ...stored, historyState },
    });
    await loading;
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      "chat.startup",
      expect.objectContaining({ cursor: "stored-cursor", knownState: stateRevision }),
      { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
    );
    expect(h.state.chatMessages).toEqual(stored.messages);
    expect(h.state.chatHistoryPagination.hasMore).toBe(false);
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
