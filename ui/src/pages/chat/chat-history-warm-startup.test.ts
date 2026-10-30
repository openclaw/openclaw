/* @vitest-environment jsdom */
import { createEffect, createRoot, flush } from "@solidjs/signals";
import { createComponent, merge } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSettings } from "../../app/settings.ts";
import { SLASH_COMMANDS } from "../../lib/chat/commands.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { sessionProgressCardsForGateway } from "../../lib/session-progress-cards.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createGatewayRequestMock } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
} from "./chat-application-context.test-support.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import {
  chatHistoryRequests,
  resetChatHistoryProjection,
  synchronizeInitialChatSnapshotConnection,
} from "./chat-history-state.ts";
import { syncSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import { loadChatHistory } from "./chat-history.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import {
  createPaneHeaderWorkspaceFixture,
  createPaneTestHost,
  getPaneTestRuntime,
  nativeHistoryMessage,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { refreshChatCommands, refreshPageChat } from "./chat-state-refresh.ts";
import type { ChatHistoryState } from "./chat-transcript-metadata.ts";
import { PaneHeaderView } from "./components/chat-pane-header.tsx";
import { resetTranscriptTestDom } from "./components/chat-transcript.test-support.ts";
import {
  observeChatCache,
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  setChatHistoryCursor,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import * as snapshotDatabase from "./session-snapshot-database.ts";
import { publishSnapshotInvalidation } from "./session-snapshot-invalidation-events.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";
import { prewarmChatSnapshot } from "./session-snapshot-prewarm.ts";
import { CHAT_SNAPSHOT_PROJECTION_VERSION } from "./session-snapshot-record.ts";
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
const emptyPendingInputs = () => ({ items: [], total: 0, queuedCount: 0 });
const queuedPendingInputs = (content = "Check the attachment before continuing.") => ({
  items: [
    {
      id: "followup-1",
      runId: "run-followup-1",
      message: { role: "user", content },
      acceptedAt: 1,
      state: "queued" as const,
      queued: true as const,
    },
  ],
  total: 1,
  queuedCount: 1,
});
const startupCommands = (name = "fixture_skill") => [
  {
    name,
    description: "Run the fixture skill",
    source: "skill" as const,
    scope: "text" as const,
    acceptsArgs: true,
  },
];
const startupRevision = () => ({
  pendingInputs: "pending-1",
  sessionInfo: "session-1",
  commands: "commands-1",
});

async function paintCachedSnapshot(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  vi.advanceTimersToNextFrame();
  await vi.advanceTimersByTimeAsync(1);
}

function mountPane(
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
  pane.sessionSnapshotStore = store;
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
    pendingResponse() {
      const response = createDeferred<unknown>();
      request.mockReturnValueOnce(response.promise);
      return response;
    },
    async cold(history: ChatHistoryState) {
      read.resolve(null);
      this.connect();
      const { commands, ...fields } = history;
      request.mockResolvedValueOnce({
        ...liveResult,
        ...fields,
        ...(commands ? { metadata: { commands } } : {}),
      });
      await this.start();
      const snapshot = this.snapshot();
      expect(snapshot?.historyState).toEqual(history);
      if (!snapshot) {
        throw new Error("Expected startup snapshot");
      }
      return snapshot;
    },
    async hydrate(snapshot: ChatSessionSnapshot | null = stored) {
      read.resolve(snapshot);
      await paintCachedSnapshot();
    },
    snapshot: () =>
      readChatSessionSnapshot(state.chatMessagesBySession!, state, { sessionKey: key }),
    expectStartup(params: Record<string, unknown>) {
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "chat.startup",
        expect.objectContaining(params),
        { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
      );
    },
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

function shareConnection(
  first: ReturnType<typeof mountPane>,
  second: ReturnType<typeof mountPane>,
) {
  second.connect();
  second.state.client = first.client;
  second.state.sessions = first.state.sessions;
}

function snapshotRecord(h: ReturnType<typeof mountPane>, snapshot: ChatSessionSnapshot) {
  return {
    projectionVersion: CHAT_SNAPSHOT_PROJECTION_VERSION,
    savedAt: Date.now(),
    sessionKey: resolveChatSnapshotKey(h.state, { sessionKey }),
    sessionId: snapshot.sessionId,
    snapshot,
  };
}

function connectSessionOwner(h: ReturnType<typeof mountPane>) {
  h.connect();
  h.request.mockImplementation(async (method) => {
    switch (method) {
      case "chat.history":
      case "chat.startup":
        return h.liveResult;
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
  it("keeps saved workspace icons passive until connection and route admission", () => {
    const h = mountPane();
    h.pane.context.gateway.connection.token = "saved-fixture-token";
    const header = () =>
      h.pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(h.state),
        { key: sessionKey, kind: "direct" },
        false,
        "/workspace/project",
        false,
        null,
      ).header;

    expect(header().workspaceIcon).toBeNull();
    h.connect();
    h.pane.routeResolutionPending = true;
    expect(header().workspaceIcon).toBeNull();
    h.pane.routeResolutionPending = false;
    expect(header().workspaceIcon).toMatchObject({ authReady: true });
    h.state.connected = false;
    expect(header().workspaceIcon).toBeNull();
  });

  it.each(["hit", "miss", "error"] as const)(
    "waits for the cached title before painting a fallback (%s)",
    async (outcome) => {
      const h = mountPane("agent:main:dashboard:cached-title");
      const view = mountSolid(() =>
        createComponent(
          PaneHeaderView,
          merge(() =>
            h.pane.renderPaneHeader(
              createPaneHeaderWorkspaceFixture(h.state),
              undefined,
              false,
              undefined,
              false,
              null,
            ),
          ),
        ),
      );
      onTestFinished(view.unmount);
      const title = () =>
        view.container.querySelector(".chat-pane__session-title-text")?.textContent?.trim();
      flush();
      expect(title()).toBe("");
      const network = h.pendingResponse();
      h.connect();
      const loading = h.start();
      expect(h.request).toHaveBeenCalledOnce();
      if (outcome === "hit") {
        h.read.resolve({
          ...stored,
          transcriptMetadata: {
            key: h.state.sessionKey,
            kind: "direct",
            label: "Cached conversation",
          },
        });
      } else if (outcome === "miss") {
        h.read.resolve(null);
      } else {
        h.read.reject(new Error("Cache unavailable"));
      }
      await paintCachedSnapshot();
      flush();
      expect(title()).toBe(outcome === "hit" ? "Cached conversation" : "New session");
      network.resolve(h.liveResult);
      await loading;
      expect(h.state.chatMessages).toEqual(liveMessages);
    },
  );

  it("rejects transcript and progress hydration when the Gateway account changes ahead of pane state", async () => {
    const h = mountPane();
    const progressCard = { sessionKey, revision: 2, updatedAt: 100, markdown: "Old account" };
    h.pane.context.gateway.snapshot.client = createGatewayBrowserClientFixture({
      offlineRecoveryScope: "another-account",
      recoveryScopeReady: false,
    });
    h.read.resolve({ ...stored, progressCard });
    await paintCachedSnapshot();
    expect(h.state.chatMessages).toEqual([]);
    expect(
      sessionProgressCardsForGateway(h.pane.context.gateway).get({ sessionKey }),
    ).toBeUndefined();
  });

  it("hydrates progress with the stored transcript before hello", async () => {
    const h = mountPane();
    const progressCard = { sessionKey, revision: 2, updatedAt: 100, markdown: "Checking results" };
    h.read.resolve({ ...stored, progressCard });
    await paintCachedSnapshot();
    expect(h.state.connected).toBe(false);
    expect(h.state.chatMessages).toEqual(stored.messages);
    expect(sessionProgressCardsForGateway(h.pane.context.gateway).get({ sessionKey })).toEqual(
      progressCard,
    );
    expect(h.request).not.toHaveBeenCalled();
  });
  it("retains the cached rows and widget heights for identical history", async () => {
    const memory: ChatMessageCache = new Map();
    const store = new SessionSnapshotStore(memory);
    observeChatCache(memory, store);
    const record = createDeferred<unknown>();
    vi.spyOn(snapshotDatabase, "readStoredChatSnapshotRecord").mockReturnValueOnce(record.promise);
    const h = mountPane(sessionKey, false, store, memory);
    const network = h.pendingResponse();
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
    h.connect();
    const loading = h.start();
    expect(h.request).toHaveBeenCalledOnce();
    const fresh = { ...h.liveResult, messages: structuredClone(stored.messages) };
    record.resolve(snapshotRecord(h, snapshot));
    await paintCachedSnapshot();
    network.resolve(fresh);
    await loading;
    flush();
    expect(paints.length).toBeGreaterThan(0);
    expect(paints.every((messages) => messages === paints[0])).toBe(true);
    expect(h.state.chatMessages).toBe(paints[0]);
    expect(h.state.chatMessages).toEqual(stored.messages);
    expect(h.snapshot()?.widgetHeights).toEqual(snapshot.widgetHeights);
  });

  it("replaces changed bytes at the same native message identity", async () => {
    const h = mountPane();
    await h.hydrate();
    const cachedMessage = h.state.chatMessages[0];
    const changedMessage = nativeHistoryMessage(1, "Updated conversation");
    h.request.mockResolvedValueOnce({ ...h.liveResult, messages: [changedMessage] });
    h.connect();
    await h.start();
    expect(h.state.chatMessages).toEqual([changedMessage]);
    expect(h.state.chatMessages[0]).not.toBe(cachedMessage);
  });

  it.each(["direct", "prewarmed"] as const)(
    "refetches reasoning omitted by the previous cached projection (%s)",
    async (mode) => {
      const cursor = "head-with-hidden-reasoning";
      const messages = [
        nativeHistoryMessage(1, "Check the evidence."),
        ...["reasoning-1", "reasoning-2"].map((id, index) => ({
          role: "assistant",
          content: [{ type: "thinking", thinking: "Compare the evidence." }],
          __openclaw: { id, seq: index + 2 },
        })),
        nativeHistoryMessage(4, "The answer is ready."),
      ];
      const cacheKey = resolveChatSnapshotKey(
        { settings: loadSettings(), client: { offlineRecoveryScope: "test-recovery-scope" } },
        { sessionKey },
      );
      vi.spyOn(snapshotDatabase, "readStoredChatSnapshotRecord").mockResolvedValueOnce({
        // Version 11 filtered out reasoning while retaining the current transcript cursor.
        projectionVersion: 11,
        savedAt: 0,
        sessionKey: cacheKey,
        sessionId: stored.sessionId,
        snapshot: {
          ...stored,
          deltaCursor: cursor,
          messages: [messages[0], messages[3]],
        },
      });
      if (mode === "prewarmed") {
        await prewarmChatSnapshot(cacheKey);
        await vi.dynamicImportSettled();
      }
      const h = mountPane(sessionKey, false, new SessionSnapshotStore());
      // A late cache read already triggers a full request; settle it before connection
      // so only projection invalidation can retire the otherwise-current cursor.
      await paintCachedSnapshot();
      h.request.mockImplementation(async (_method, params) =>
        typeof params === "object" &&
        params !== null &&
        "cursor" in params &&
        params.cursor === cursor
          ? { kind: "delta", messages: [], deltaCursor: cursor, sessionId: stored.sessionId }
          : { ...h.liveResult, messages, deltaCursor: cursor },
      );
      h.connect();
      await h.start();
      expect(h.request).toHaveBeenCalledExactlyOnceWith(
        "chat.startup",
        expect.not.objectContaining({ cursor: expect.anything() }),
        { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
      );
      expect(h.state.chatMessages).toEqual(messages);
    },
  );

  it.each([false, true])(
    "requests history without waiting for storage and ignores a late snapshot (subscription=%s)",
    async (subscribe) => {
      const h = mountPane();
      const network = h.pendingResponse();
      if (subscribe) {
        connectSessionOwner(h);
      } else {
        h.connect();
      }
      const subscription = subscribe
        ? syncSelectedSessionMessageSubscription(h.state, { initialHistory: true })
        : undefined;
      const loading = h.start();
      await vi.waitFor(() =>
        expect(h.request).toHaveBeenCalledExactlyOnceWith(
          subscribe ? "sessions.messages.subscribe" : "chat.startup",
          subscribe
            ? expect.objectContaining({
                initialHistory: expect.not.objectContaining({ cursor: expect.anything() }),
              })
            : expect.not.objectContaining({ cursor: expect.anything() }),
          expect.anything(),
        ),
      );
      network.resolve(
        subscribe
          ? { key: sessionKey, initialHistory: { ok: true, payload: h.liveResult } }
          : h.liveResult,
      );
      await subscription;
      await loading;
      expect(h.state.chatMessages).toEqual(liveMessages);
      h.read.resolve(stored);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.state.chatMessages).toEqual(liveMessages);
      expect(h.request).toHaveBeenCalledOnce();
    },
  );

  it("uses the subscribed full page when storage restores a cursor while it is pending", async () => {
    const h = mountPane();
    const network = h.pendingResponse();
    connectSessionOwner(h);
    const subscription = syncSelectedSessionMessageSubscription(h.state, { initialHistory: true });
    const loading = h.start();
    await vi.waitFor(() =>
      expect(h.request).toHaveBeenCalledExactlyOnceWith(
        "sessions.messages.subscribe",
        expect.objectContaining({
          initialHistory: expect.not.objectContaining({ cursor: expect.anything() }),
        }),
        expect.anything(),
      ),
    );
    const historyState = {
      stateRevision: startupRevision(),
      pendingInputs: emptyPendingInputs(),
      commands: startupCommands(),
      sessionInfo: h.liveResult.sessionInfo,
    };
    await h.hydrate({ ...stored, historyState });
    network.resolve({ key: sessionKey, initialHistory: { ok: true, payload: h.liveResult } });
    await subscription;
    await loading;
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.state.chatMessages).toEqual(liveMessages);
  });

  it("requests the current cursor when a subscribed delta's cached cursor changes", async () => {
    const h = mountPane();
    await h.hydrate();
    const network = h.pendingResponse();
    connectSessionOwner(h);
    const subscription = syncSelectedSessionMessageSubscription(h.state, { initialHistory: true });
    const loading = h.start();
    await vi.waitFor(() =>
      expect(h.request).toHaveBeenCalledExactlyOnceWith(
        "sessions.messages.subscribe",
        expect.objectContaining({
          initialHistory: expect.objectContaining({ cursor: stored.deltaCursor }),
        }),
        expect.anything(),
      ),
    );
    setChatHistoryCursor(h.state, "newer-cache-cursor");
    network.resolve({ key: sessionKey, initialHistory: { ok: true, payload: h.liveResult } });
    await subscription;
    await loading;
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.request).toHaveBeenLastCalledWith(
      "chat.startup",
      expect.objectContaining({ cursor: "newer-cache-cursor" }),
      expect.anything(),
    );
    expect(h.state.chatMessages).toEqual(liveMessages);
  });

  it.each(["unchanged", "changed", "empty", "replacement"] as const)(
    "restores only receipt-matched warm metadata when server state is %s",
    async (change) => {
      const initial = mountPane();
      const original = {
        pendingInputs: queuedPendingInputs(),
        commands: startupCommands(),
        stateRevision: startupRevision(),
        sessionInfo: { ...initial.liveResult.sessionInfo, snapshotAt: 100 },
      };
      const snapshot = await initial.cold(original);
      const warm = mountPane();
      await warm.hydrate(snapshot);
      const response = warm.pendingResponse();
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
        expect.objectContaining({ cursor: "live-cursor", knownState: original.stateRevision }),
        expect.anything(),
      );

      const emptyInputs = emptyPendingInputs();
      const next = {
        pendingInputs:
          change === "unchanged"
            ? original.pendingInputs
            : change === "changed"
              ? queuedPendingInputs("Updated followup.")
              : emptyInputs,
        sessionInfo: {
          ...warm.liveResult.sessionInfo,
          snapshotAt: 200,
          ...(change === "replacement" ? { sessionId: "replacement-session" } : {}),
        },
        stateRevision:
          change === "unchanged"
            ? original.stateRevision
            : {
                pendingInputs: "pending-2",
                sessionInfo: change === "replacement" ? "session-2" : "session-1",
                commands: change === "changed" || change === "empty" ? "commands-2" : "commands-1",
              },
        commands:
          change === "empty"
            ? []
            : change === "changed"
              ? startupCommands("replacement_skill")
              : original.commands,
      };
      const metadata =
        next.stateRevision.commands === original.stateRevision.commands
          ? {}
          : { commands: next.commands };
      // A sibling may publish a newer cache while this request still owns its earlier receipts.
      cacheChatSessionSnapshot(
        warm.state.chatMessagesBySession!,
        warm.state,
        { sessionKey },
        {
          ...snapshot,
          historyState: {
            stateRevision: next.stateRevision,
            pendingInputs: emptyInputs,
            sessionInfo: next.sessionInfo,
          },
        },
      );
      response.resolve({
        metadata,
        ...(change === "replacement"
          ? {
              ...warm.liveResult,
              sessionInfo: next.sessionInfo,
              pendingInputs: next.pendingInputs,
              stateRevision: next.stateRevision,
            }
          : {
              kind: "delta",
              messages: [],
              deltaCursor: "next-cursor",
              stateRevision: next.stateRevision,
              sessionInfoSnapshotAt: next.sessionInfo.snapshotAt,
              ...(change === "unchanged" ? {} : { pendingInputs: next.pendingInputs }),
            }),
      });
      await loading;
      await refreshChatCommands(warm.state);
      expect(warm.request.mock.calls.some(([method]) => method === "commands.list")).toBe(false);
      expect(SLASH_COMMANDS.some((command) => command.name === "fixture_skill")).toBe(
        next.commands === original.commands,
      );
      expect(SLASH_COMMANDS.some((command) => command.name === "replacement_skill")).toBe(
        change === "changed",
      );
      expect(warm.state.chatPendingInputs?.page).toEqual(next.pendingInputs);
      expect(warm.state.chatPendingInputs?.queuedInputs).toEqual(next.pendingInputs.items);
      expect(warm.state.currentSessionId).toBe(next.sessionInfo.sessionId);
      expect(warm.snapshot()?.historyState).toEqual(next);
    },
  );

  it("does not advertise a command revision without the retained catalog", async () => {
    const h = mountPane();
    await h.hydrate({ ...stored, historyState: { stateRevision: { commands: "commands-1" } } });
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
    const response = h.pendingResponse();
    h.connect();
    const loading = h.start();
    const pendingCacheJoin = h.start();
    await h.hydrate();
    expect(h.state.chatMessages).toEqual(stored.messages);
    expect(h.request).not.toHaveBeenCalled();
    admission.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    h.expectStartup({ sessionKey, cursor: "stored-cursor" });
    const shared = h.start();
    response.resolve(delta);
    await Promise.all([loading, pendingCacheJoin, shared]);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.state.chatMessages).toEqual(stored.messages);
  });

  it.each(["different receipts", "missing inputs"] as const)(
    "separates startup requests with %s",
    async (difference) => {
      const initial = mountPane();
      const pendingInputs =
        difference === "missing inputs" ? queuedPendingInputs() : emptyPendingInputs();
      const stateRevision = { pendingInputs: "pending-1", sessionInfo: "info-1" };
      const history = { pendingInputs, stateRevision, sessionInfo: initial.liveResult.sessionInfo };
      const snapshot = await initial.cold(history);
      const secondHistory =
        difference === "missing inputs"
          ? { stateRevision, sessionInfo: history.sessionInfo }
          : { ...history, stateRevision: { ...stateRevision, sessionInfo: "info-2" } };
      const first = mountPane();
      const second = mountPane();
      first.read.resolve(snapshot);
      second.read.resolve({ ...snapshot, historyState: secondHistory });
      await paintCachedSnapshot();
      first.connect();
      shareConnection(first, second);
      const omitted = createDeferred<unknown>();
      const full = createDeferred<unknown>();
      first.request.mockReturnValueOnce(omitted.promise).mockReturnValueOnce(full.promise);
      const loads = [first.start(), second.start()];
      expect(first.request).toHaveBeenCalledTimes(2);
      expect(first.request.mock.calls.map(([, params]) => params)).toEqual([
        expect.objectContaining({ knownState: stateRevision }),
        expect.objectContaining({
          knownState:
            difference === "missing inputs"
              ? { sessionInfo: "info-1" }
              : secondHistory.stateRevision,
        }),
      ]);
      const delta = {
        kind: "delta",
        messages: [],
        deltaCursor: "next-cursor",
        stateRevision,
        sessionInfoSnapshotAt: 2,
        ...(difference === "different receipts"
          ? { sessionInfo: { ...history.sessionInfo, label: "Latest label" } }
          : {}),
      };
      omitted.resolve(delta);
      full.resolve({ ...delta, pendingInputs });
      await Promise.all(loads);
      expect(first.state.chatPendingInputs?.queuedInputs).toEqual(pendingInputs.items);
      expect(second.state.chatPendingInputs?.queuedInputs).toEqual(pendingInputs.items);
      expect(first.state.chatPendingInputs?.page).toEqual(pendingInputs);
      expect(second.state.chatPendingInputs?.page).toEqual(pendingInputs);
    },
  );

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
      const first = mountPane(sessionKey, false, store, memory);
      const second = mountPane(sessionKey, false, store, memory);
      connectSessionOwner(first);
      shareConnection(first, second);
      const messages = ordering === "unchanged" ? structuredClone(stored.messages) : liveMessages;
      first.request.mockImplementation(async () => ({ ...first.liveResult, messages }));
      const loading = [first.start(), second.start()];
      firstRead.resolve(stored);
      await loading[0];
      secondRead.resolve(null);
      await Promise.all(loading);
      expect(first.state.chatMessages).toEqual(messages);
      expect(second.state.chatMessages).toEqual(messages);
      expect(second.snapshot()?.messages).toEqual(messages);
    },
  );

  it("retires the prior session capability while its history request is pending", async () => {
    const h = mountPane();
    const { gateway, sessions } = connectSessionOwner(h);
    const network = h.pendingResponse();
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
    network.resolve(h.liveResult);
    await expect(retired).resolves.toBeUndefined();
    await current;
    expect(sessions.state.result).toBeNull();
    expect(replacement.state.result?.sessions[0]).toMatchObject(h.liveResult.sessionInfo);
    expect(h.state.chatMessages).toEqual(liveMessages);
  });

  it.each([
    ...[true, false].flatMap((beforeHello) =>
      (["current", "scope", "generation"] as const).map((transition) => ({
        beforeHello,
        transition,
        hidden: false,
      })),
    ),
    { beforeHello: false, transition: "current" as const, hidden: true },
  ])(
    "displays prepared rows before dispatch with scope-owned live receipts across cache retirement ($transition, beforeHello=$beforeHello, hidden=$hidden)",
    async ({ beforeHello, transition, hidden }) => {
      vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
      const cacheKey = resolveChatSnapshotKey(
        { settings: loadSettings(), client: { offlineRecoveryScope: "test-recovery-scope" } },
        { sessionKey },
      );
      const stateRevision = startupRevision();
      const historyState: ChatHistoryState = {
        stateRevision,
        pendingInputs: emptyPendingInputs(),
        sessionInfo: { key: sessionKey, kind: "direct", sessionId: "warm-session", updatedAt: 1 },
        commands: startupCommands(),
      };
      vi.spyOn(snapshotDatabase, "readStoredChatSnapshotRecord").mockResolvedValueOnce({
        projectionVersion: CHAT_SNAPSHOT_PROJECTION_VERSION,
        savedAt: 0,
        sessionKey: cacheKey,
        sessionId: stored.sessionId,
        snapshot: { ...stored, historyState },
      });
      await prewarmChatSnapshot(cacheKey);
      await vi.dynamicImportSettled();
      const h = mountPane(sessionKey, false, new SessionSnapshotStore());
      expect(h.state.connected).toBe(false);
      expect(h.state.chatMessages).toEqual(stored.messages);
      expect(h.snapshot()).toMatchObject({ ...stored, historyState });
      expect(chatHistoryRequests(h.state).acceptedHistory).toBeUndefined();
      const dispatch = createDeferred<boolean>();
      Object.defineProperty(h.client, "connectSent", {
        get: () => dispatch.promise,
      });
      connectSessionOwner(h);
      h.state.connected = !beforeHello;
      let rowsAtDispatch: unknown[] | undefined;
      let snapshotAtDispatch: ChatSessionSnapshot | null | undefined;
      h.request.mockImplementationOnce(async () => {
        rowsAtDispatch = h.state.chatMessages.slice();
        snapshotAtDispatch = h.snapshot();
        if (transition === "scope") {
          Object.defineProperty(h.client, "recoveryScope", { value: "replacement-scope" });
        } else if (transition === "generation") {
          await publishSnapshotInvalidation({});
        }
        if (beforeHello) {
          h.connect();
          void syncSelectedSessionMessageSubscription(h.state);
        }
        return {
          key: sessionKey,
          initialHistory: {
            ok: true,
            payload: {
              kind: "delta",
              messages: [],
              deltaCursor: "current-cursor",
              sessionInfo: h.liveResult.sessionInfo,
            },
          },
        };
      });
      const subscription = syncSelectedSessionMessageSubscription(h.state, {
        initialHistory: true,
        beforeHello,
      });
      if (beforeHello) {
        expect(h.request).not.toHaveBeenCalled();
        expect(h.state.chatMessages).toEqual(stored.messages);
      }
      dispatch.resolve(true);
      await subscription;
      expect(rowsAtDispatch).toEqual(stored.messages);
      expect(snapshotAtDispatch).toMatchObject({ ...stored, historyState });
      expect(chatHistoryRequests(h.state).acceptedHistory).toBeUndefined();
      expect(h.request).toHaveBeenCalledExactlyOnceWith(
        "sessions.messages.subscribe",
        expect.objectContaining({
          initialHistory: expect.objectContaining({
            cursor: stored.deltaCursor,
            knownState: stateRevision,
          }),
        }),
        expect.anything(),
      );
      await h.start();
      const scopeChanged = transition === "scope";
      expect(h.request).toHaveBeenCalledTimes(scopeChanged ? 2 : 1);
      expect(h.state.chatMessages).toEqual(scopeChanged ? liveMessages : stored.messages);
      expect(chatHistoryRequests(h.state).acceptedHistory).toMatchObject({
        client: h.client,
        connectionEpoch: h.state.connectionEpoch,
        sessionKey,
      });
    },
  );

  it("sends the retained cursor and receipts once storage has settled", async () => {
    const record = createDeferred<unknown>();
    vi.spyOn(snapshotDatabase, "readStoredChatSnapshotRecord").mockReturnValueOnce(record.promise);
    void prewarmChatSnapshot(
      resolveChatSnapshotKey(
        { settings: loadSettings(), client: { offlineRecoveryScope: "test-recovery-scope" } },
        { sessionKey },
      ),
    );
    // Boot reads before the deferred pane mounts; hello and stream admission
    // need not leave another task for the pane's asynchronous hydration.
    await vi.advanceTimersByTimeAsync(16);
    const h = mountPane(sessionKey, true, new SessionSnapshotStore());
    const stateRevision = startupRevision();
    const historyState = {
      stateRevision,
      pendingInputs: emptyPendingInputs(),
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
    record.resolve(snapshotRecord(h, { ...stored, historyState }));
    const hydration = chatHistoryRequests(h.state).initialSnapshotHydration?.promise;
    await paintCachedSnapshot();
    await hydration;
    await h.start();
    h.expectStartup({ cursor: "stored-cursor", knownState: stateRevision });
    expect(h.state.chatMessages).toEqual(stored.messages);
    expect(h.state.chatHistoryPagination.hasMore).toBe(false);
  });

  it.each(["disconnect", "reset", "session-switch"] as const)(
    "retires cache and history publication on %s",
    async (transition) => {
      const h = mountPane();
      const network = h.pendingResponse();
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
      network.resolve(h.liveResult);
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
