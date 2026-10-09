/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createRouter, definePage } from "@openclaw/uirouter";
import { IDBFactory } from "fake-indexeddb";
import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow, ModelCatalogEntry } from "../../api/types.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveChatThinkingSelectState } from "../../lib/chat/thinking.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { rewindChatHistory, switchChatHistoryBranch } from "./chat-history-actions.ts";
import type { ChatHistoryResponse } from "./chat-history-snapshot.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { subscribeChatPaneSnapshotInvalidation } from "./chat-pane-startup-subscriptions.ts";
import {
  createInitializationContext,
  createRenderTestChatPane,
  nativeHistoryMessage,
} from "./chat-pane.test-support.ts";
import { createPageState } from "./chat-state-page.ts";
import {
  refreshChatMetadata,
  refreshPageChat,
  retireChatMetadataRequests,
} from "./chat-state-refresh.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { renderChat } from "./chat-view.ts";
import { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { loadChatRoute } from "./route-loader.ts";
import {
  applyChatCacheSnapshot,
  cacheChatSessionSnapshot,
  observeChatCache,
  resolveChatSnapshotKey,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import type { ChatRouteData } from "./session-route-data.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";

const key = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const initial = {
  key,
  agentId: "main",
  sessionId: "history-observation-session",
  kind: "direct",
  updatedAt: 10,
  label: "Initial session",
} satisfies GatewaySessionRow;
const sibling = { ...initial, key: "agent:main:sibling", sessionId: "sibling", label: "Sibling" };
const query = { ownerId: "ada", agentId: "main" };
function history(row: GatewaySessionRow): ChatHistoryResponse {
  return {
    sessionInfo: row,
    sessionId: row.sessionId,
    messages: [{ role: "assistant", content: "Observed transcript" }],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", createStorageMock());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function fixture(primary = initial, observeManaged = true, models: ModelCatalogEntry[] = []) {
  let managed = sessionsResult([primary, sibling], 10);
  let heldList: ReturnType<typeof createDeferred<ReturnType<typeof sessionsResult>>> | undefined;
  const reads: Array<{
    method: string;
    params: unknown;
    pending: ReturnType<typeof createDeferred<ChatHistoryResponse>>;
  }> = [];
  const client = createTestGatewayClient((method, params) => {
    if (method === "sessions.list") {
      return (params as { ownerId?: string }).ownerId
        ? (heldList?.promise ?? managed)
        : sessionsResult([primary, sibling], 10);
    }
    if (method === "models.list") {
      return { models };
    }
    if (method === "sessions.resolve") {
      return { ok: true, key, agentId: "main", displayName: "Observed session" };
    }
    if (method === "chat.history" || method === "chat.startup") {
      const pending = createDeferred<ChatHistoryResponse>();
      reads.push({ method, params, pending });
      return pending.promise;
    }
    return {};
  });
  const { gateway } = createGatewayHarness(client);
  const sessions = createTestSessionCapability(gateway);
  const capabilities = [sessions];
  const unsubscribe = observeManaged ? sessions.subscribeList(query, () => {}) : undefined;
  const context = { ...createInitializationContext(), sessions };
  const pageGateway = context.gateway;
  context.gateway = {
    ...pageGateway,
    ...gateway,
    get snapshot() {
      return { ...pageGateway.snapshot, ...gateway.snapshot };
    },
    subscribe(listener) {
      return gateway.subscribe((next) => listener({ ...pageGateway.snapshot, ...next }));
    },
  };
  const operations: Promise<unknown>[] = [];
  onTestFinished(async () => {
    heldList?.resolve(managed);
    for (const read of reads) {
      read.pending.resolve(history(initial));
    }
    await Promise.allSettled(operations);
    unsubscribe?.();
    capabilities.forEach((capability) => capability.dispose());
  });
  await sessions.refresh({ force: true, agentId: "main" });
  if (observeManaged) {
    await sessions.refreshList(query);
  }

  const makeState = (owner = sessions) => {
    const state = createPageState(
      { ...context, sessions: owner },
      { invalidate: vi.fn(), afterCommit: () => () => {} },
      document.createElement("div"),
    );
    state.client = client;
    state.connected = true;
    state.connectionEpoch = 1;
    state.sessionKey = key;
    state.sessionsResult = owner.state.result;
    state.sessionsResultAgentId = owner.state.agentId;
    return state;
  };
  const begin = (state: ReturnType<typeof makeState>, startup = false) => {
    const historyLoad = loadChatHistory(state, { deferBranches: true, startup });
    const settled = refreshPageChat(state, {
      historyLoad,
      awaitHistory: true,
      scheduleScroll: false,
    });
    operations.push(settled);
    return settled;
  };
  return {
    begin,
    capabilities,
    client,
    context,
    gateway,
    makeState,
    operations,
    reads,
    sessions,
    managedRow: () => sessions.listSnapshot(query).result?.sessions.find((row) => row.key === key),
    refreshManaged: (row: GatewaySessionRow) => {
      managed = sessionsResult([row, sibling], 30);
      const refresh = sessions.refreshList({ ...query, force: true });
      operations.push(refresh);
      return refresh;
    },
    holdManaged: () => {
      heldList = createDeferred<ReturnType<typeof sessionsResult>>();
      const refresh = sessions.refreshList({ ...query, force: true });
      operations.push(refresh);
      return { resolve: heldList.resolve, refresh };
    },
  };
}

function seedCursor(state: ReturnType<Awaited<ReturnType<typeof fixture>>["makeState"]>) {
  const snapshot = {
    messages: [{ role: "assistant", content: "Cached transcript" }],
    sessionId: initial.sessionId,
    pagination: { hasMore: false },
    deltaCursor: "cursor-observation",
  } satisfies ChatSessionSnapshot;
  applyChatCacheSnapshot(state, snapshot);
  cacheChatSessionSnapshot(state.chatMessagesBySession, state, { sessionKey: key }, snapshot);
}

describe("history descriptor observation order", () => {
  it.each([
    { name: "shorter", ids: ["off"], reasoning: false },
    { name: "omitted", ids: undefined, reasoning: true },
  ])(
    "adopts a current $name thinking profile without reviving an older list",
    async ({ ids, reasoning }) => {
      const thinkingDefault = ids?.length === 0 ? undefined : "off";
      const previousIds = ["off", "minimal", "low", "medium", "high"];
      const base = {
        ...initial,
        modelProvider: "lmstudio",
        model: "my-local-model",
        agentRuntime: { id: "openclaw", source: "model" as const },
      };
      const prepared = {
        ...base,
        thinkingLevels: previousIds.map((id) => ({ id, label: id })),
        thinkingOptions: previousIds,
        thinkingDefault: "off",
      };
      const models: ModelCatalogEntry[] = [
        {
          provider: base.modelProvider,
          id: base.model,
          name: "Synthetic local model",
          agentRuntime: base.agentRuntime,
          reasoning,
          thinkingLevels: (ids ?? previousIds).map((id) => ({ id, label: id })),
          ...(thinkingDefault === undefined ? {} : { thinkingDefault }),
        },
      ];
      const h = await fixture(prepared, true, models);
      const state = h.makeState();
      onTestFinished(() => {
        state.connected = false;
        retireChatMetadataRequests(state);
      });
      await refreshChatMetadata(state);
      expect(state.chatModelCatalog).toEqual(models);
      expect(state.chatModelCatalogError).toBeNull();
      const profile =
        ids === undefined
          ? {}
          : {
              thinkingLevels: ids.map((id) => ({ id, label: id })),
              thinkingOptions: ids,
              ...(thinkingDefault === undefined ? {} : { thinkingDefault }),
            };
      const oldList = h.holdManaged();
      const loaded = h.begin(state);
      h.reads[0]!.pending.resolve(history({ ...base, ...profile }));
      await loaded;
      const expectedIds = ids ?? previousIds;
      const primaryRow = () => h.sessions.state.result?.sessions.find((row) => row.key === key);
      expect(primaryRow()?.thinkingLevels?.map(({ id }) => id)).toEqual(expectedIds);
      expect(state.sessionsResult).toBe(h.sessions.state.result);
      const thinking = resolveChatThinkingSelectState({
        session: selectedChatSessionRow(state),
        catalog: state.chatModelCatalog,
        sessionKey: key,
        sessionsResult: state.sessionsResult,
      });
      expect(thinking.options.map(({ value }) => value)).toEqual(
        ids === undefined ? previousIds : [],
      );
      expect(thinking.inherited.value).toBe(thinkingDefault ?? "");
      expect(primaryRow()?.thinkingDefault).toBe(thinkingDefault);

      oldList.resolve(sessionsResult([prepared, sibling], 10));
      await oldList.refresh;
      expect(primaryRow()?.thinkingLevels?.map(({ id }) => id)).toEqual(expectedIds);
      expect(h.managedRow()?.thinkingLevels?.map(({ id }) => id)).toEqual(expectedIds);
      expect(primaryRow()?.thinkingDefault).toBe(thinkingDefault);
      expect(h.managedRow()?.thinkingDefault).toBe(thinkingDefault);
    },
  );

  it("keeps the newer primary-held delta descriptor over an older full read without timestamps", async () => {
    const h = await fixture(initial, false);
    const full = h.begin(h.makeState());
    const cursorState = h.makeState();
    seedCursor(cursorState);
    const delta = h.begin(cursorState);
    expect(h.reads).toHaveLength(2);
    expect(h.reads[0]!.params).not.toHaveProperty("cursor");
    expect(h.reads[1]!.params).toHaveProperty("cursor", "cursor-observation");
    const fresh = { ...initial, updatedAt: null, label: "Current delta descriptor" };
    h.reads[1]!.pending.resolve({
      kind: "delta",
      messages: [],
      sessionInfo: fresh,
      deltaCursor: "cursor-current",
    });
    await delta;
    expect(h.sessions.state.result?.sessions.find((row) => row.key === key)?.label).toBe(
      fresh.label,
    );
    h.reads[0]!.pending.resolve(
      history({ ...initial, updatedAt: null, label: "Earlier full read" }),
    );
    await full;
    expect(h.sessions.state.result?.sessions.find((row) => row.key === key)?.label).toBe(
      fresh.label,
    );
  });

  it("does not let a late shared consumer recapture an older history result", async () => {
    const h = await fixture();
    const first = h.begin(h.makeState());
    const current = { ...initial, updatedAt: 5, label: "Newer managed read" };
    await h.refreshManaged(current);
    expect(h.sessions.state.result?.sessions.find((row) => row.key === key)).toMatchObject(current);
    const late = h.begin(h.makeState());
    expect(h.reads).toHaveLength(1);
    h.reads[0]!.pending.resolve(
      history({ ...initial, updatedAt: 50, label: "Older history read" }),
    );
    await Promise.all([first, late]);

    // Both projections must retain the accepted managed read, not the late history descriptor.
    expect(h.managedRow()).toMatchObject(current);
    expect(h.sessions.state.result?.sessions.find((row) => row.key === key)).toMatchObject(current);
    expect(h.sessions.state.result?.sessions.map((row) => row.key)).toEqual([key, sibling.key]);
  });

  it("uses the successful chat.startup retry's observation for shared consumers", async () => {
    const method = "chat.startup";
    const h = await fixture();
    const firstState = h.makeState();
    const first = h.begin(firstState, method === "chat.startup");
    expect(h.reads).toHaveLength(1);
    expect(h.reads[0]!.method).toBe(method);
    h.reads[0]!.pending.reject(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "session history is rebuilding; retry shortly",
        details: { method },
        retryable: true,
        retryAfterMs: 250,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const between = { ...initial, label: "Roster read between attempts" };
    await h.refreshManaged(between);
    expect(h.managedRow()?.label).toBe(between.label);

    const joinedState = h.makeState();
    const joined = h.begin(joinedState, method === "chat.startup");
    expect(h.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(h.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reads).toHaveLength(2);
    expect(h.reads[1]!.method).toBe(method);
    expect(h.reads[1]!.params).toEqual(h.reads[0]!.params);
    const recovered = { ...initial, label: "Descriptor from successful retry" };
    h.reads[1]!.pending.resolve(history(recovered));
    await Promise.all([first, joined]);

    for (const state of [firstState, joinedState]) {
      expect(state.chatMessages).toHaveLength(1);
      expect(state.currentSessionId).toBe(initial.sessionId);
      expect(state.chatLoading).toBe(false);
    }
    expect(h.reads).toHaveLength(2);
    expect.soft(h.managedRow()?.label).toBe(recovered.label);
    expect
      .soft(h.sessions.state.result?.sessions.find((row) => row.key === key)?.label)
      .toBe(recovered.label);
  });

  it("starts a distinct history read when the capability changes on the same client", async () => {
    const h = await fixture();
    const state = h.makeState();
    const first = h.begin(state);
    const replacement = createTestSessionCapability(h.gateway);
    h.capabilities.push(replacement);
    await replacement.refresh({ force: true, agentId: "main" });
    state.sessions = replacement;
    const second = h.begin(state);
    expect(h.reads).toHaveLength(2);
    h.reads[0]!.pending.resolve(
      history({ ...initial, updatedAt: 100, label: "Retired capability" }),
    );
    h.reads[1]!.pending.resolve(
      history({ ...initial, updatedAt: 20, label: "Current capability" }),
    );
    await Promise.all([first, second]);

    expect(replacement.state.result?.sessions.find((row) => row.key === key)?.label).toBe(
      "Current capability",
    );
    expect(h.sessions.state.result?.sessions.find((row) => row.key === key)?.label).toBe(
      initial.label,
    );
  });

  it("observes a reset fallback page at that page read's issuance", async () => {
    const h = await fixture();
    const state = h.makeState();
    seedCursor(state);
    const loaded = h.begin(state);
    expect(h.reads[0]!.params).toHaveProperty("cursor", "cursor-observation");
    await h.refreshManaged({ ...initial, updatedAt: 5, label: "Between cursor and page" });
    h.reads[0]!.pending.resolve({ kind: "reset" });
    await vi.waitFor(() => expect(h.reads).toHaveLength(2));
    expect(h.reads[1]!.params).not.toHaveProperty("cursor");
    h.reads[1]!.pending.resolve(
      history({ ...initial, updatedAt: 20, label: "Fallback page read" }),
    );
    await loaded;

    expect(h.managedRow()?.label).toBe("Fallback page read");
  });

  it("orders short-route pane history by the retried request issuance", async () => {
    const h = await fixture({ ...initial, key: "agent:main:unrelated", sessionId: "unrelated" });
    const lifecycle = new AbortController();
    const router = createRouter<RouteId, ApplicationContext, null, ChatRouteData>({
      routes: [
        definePage({
          id: "chat",
          path: "/chat",
          component: () => null,
          loader: (context, { location, signal }) =>
            loadChatRoute(context, location, "chat", signal),
        }),
      ],
    });
    const context: ApplicationContext = {
      ...h.context,
      router,
      lifecycleAbortSignal: lifecycle.signal,
    };
    onTestFinished(() => {
      lifecycle.abort();
      router.stop();
    });
    const navigation = router.navigate("chat", context, undefined, {
      pathname: "/chat/main/observed-session-12345678",
      search: "",
      hash: "",
    });
    h.operations.push(navigation);
    await navigation;
    expect(router.getState().matches[0]?.data).toMatchObject({
      kind: "session",
      sessionKey: key,
    });
    expect(h.reads).toHaveLength(0);
    const pane = h.makeState();
    const loaded = h.begin(pane, true);
    await vi.waitFor(() => expect(h.reads).toHaveLength(1));
    expect(h.reads[0]!.method).toBe("chat.startup");
    expect(h.reads[0]!.params).toMatchObject({ sessionKey: key });
    h.reads[0]!.pending.reject(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "session history is rebuilding; retry shortly",
        details: { method: "chat.startup" },
        retryable: true,
        retryAfterMs: 250,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await h.refreshManaged({ ...initial, updatedAt: 5, label: "Between startup attempts" });
    expect(h.managedRow()?.label).toBe("Between startup attempts");
    await vi.advanceTimersByTimeAsync(499);
    expect(h.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reads).toHaveLength(2);
    expect(h.reads[1]!.method).toBe("chat.startup");
    expect(h.reads[1]!.params).toEqual(h.reads[0]!.params);
    const startupRow = {
      ...initial,
      updatedAt: 50,
      label: "Startup retry descriptor",
    };
    h.reads[1]!.pending.resolve(history(startupRow));
    await loaded;

    expect(h.reads).toHaveLength(2);
    expect(pane.chatMessages).toHaveLength(1);
    expect(pane.currentSessionId).toBe(initial.sessionId);
    expect(pane.chatLoading).toBe(false);
    expect.soft(h.managedRow()?.label).toBe(startupRow.label);
    expect.soft(h.sessions.state.result?.sessions.some((row) => row.key === key)).toBe(true);
  });
});

it.each([false, true])(
  "publishes Retry history through the page owner (startup: %s)",
  async (startup) => {
    installTranscriptDomMocks();
    const h = await fixture();
    const pane = createRenderTestChatPane();
    const state = pane.initialize(h.context);
    state.client = h.client;
    state.connected = true;
    state.connectionEpoch = 1;
    state.sessionKey = key;
    state.sessionsResult = h.sessions.state.result;
    state.sessionsResultAgentId = h.sessions.state.agentId;
    const container = document.createElement("div");
    document.body.append(container);
    const renderCurrent = () => {
      pane.render();
      render(
        renderChat({
          ...expectDefined(pane.chatProps, "Rendered chat props"),
          historyState: state,
        }),
        container,
      );
    };
    onTestFinished(async () => {
      render(nothing, container);
      container.remove();
      retireChatMetadataRequests(state);
      await vi.dynamicImportSettled();
      resetTranscriptTestDom();
    });

    const failed = h.begin(state, startup);
    expectDefined(h.reads[0], "Initial history request").pending.reject(
      new Error("Temporary history failure"),
    );
    await failed;
    expect(getChatHistoryLoadState(state).phase).toBe("failed");
    const older = h.holdManaged();
    renderCurrent();
    const retry = expectDefined(
      container.querySelector<HTMLButtonElement>(".chat-history-error button"),
      "Retry button",
    );
    expect(retry.textContent?.trim()).toBe("Retry");
    retry.click();
    retry.click();
    expect(h.reads.map((read) => read.method)).toEqual([
      startup ? "chat.startup" : "chat.history",
      startup ? "chat.startup" : "chat.history",
    ]);
    const fresh = {
      ...initial,
      updatedAt: 30,
      label: "Current retry descriptor",
      placement: {
        state: "active",
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 30,
        stateChangedAtMs: 30,
        environmentId: "worker:retry",
        activeOwnerEpoch: 1,
        workerBundleHash: "a".repeat(64),
        workspaceBaseManifestRef: "retry-base",
        remoteWorkspaceDir: "/workspace/synthetic",
      },
    } satisfies GatewaySessionRow;
    expectDefined(h.reads[1], "Retry history request").pending.resolve(history(fresh));
    await vi.waitFor(() => expect(getChatHistoryLoadState(state).phase).toBe("committed"));
    renderCurrent();
    expect(container.querySelector(".chat-history-error")).toBeNull();
    expect(state.chatMessages).toEqual([{ role: "assistant", content: "Observed transcript" }]);
    expect
      .soft(h.sessions.state.result?.sessions.find((row) => row.key === key))
      .toMatchObject(fresh);
    expect.soft(h.managedRow()).toMatchObject(fresh);
    expect.soft(selectedChatSessionRow(state)).toMatchObject(fresh);

    older.resolve(sessionsResult([initial, sibling], 10));
    await older.refresh;
    expect
      .soft(h.sessions.state.result?.sessions.find((row) => row.key === key))
      .toMatchObject(fresh);
    expect.soft(h.managedRow()).toMatchObject(fresh);
    expect.soft(selectedChatSessionRow(state)).toMatchObject(fresh);
    expect(h.sessions.state.result?.sessions.map((row) => row.key).toSorted()).toEqual(
      [key, sibling.key].toSorted(),
    );
    expect(h.reads).toHaveLength(2);
  },
);

it("keeps an authoritative empty startup committed when its cache entry is evicted", async () => {
  vi.useRealTimers();
  vi.stubGlobal("indexedDB", new IDBFactory());
  const h = await fixture(initial, false);
  const state = h.makeState();
  state.sessionKey = "agent:main:empty";
  const store = new SessionSnapshotStore(state.chatMessagesBySession);
  store.connect();
  observeChatCache(state.chatMessagesBySession, store);
  const stop = subscribeChatPaneSnapshotInvalidation(() => state);
  onTestFinished(async () => {
    stop();
    store.disconnect();
    await store.whenIdle();
    await clearStoredChatSnapshots();
  });

  const broadcasts = vi.spyOn(localStorage, "setItem");
  const loading = h.begin(state, true);
  expect(getChatHistoryLoadState(state).phase).toBe("in-flight");
  expectDefined(h.reads[0], "Startup request").pending.resolve({ messages: [] });
  await loading;

  expect(getChatHistoryLoadState(state).phase).toBe("committed");
  expect(state.chatMessages).toEqual([]);
  expect(state.currentSessionId).toBeNull();
  const snapshotKey = resolveChatSnapshotKey(state, { sessionKey: state.sessionKey });
  expect(await store.read(snapshotKey)).toBeNull();
  const eviction = expectDefined(
    broadcasts.mock.calls.findLast(
      ([name]) => name === "openclaw.control.chatSnapshots.invalidate.v1",
    )?.[1],
    "Cache eviction broadcast",
  );
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: "openclaw.control.chatSnapshots.invalidate.v1",
      newValue: eviction,
    }),
  );
  expect(getChatHistoryLoadState(state).phase).toBe("committed");
  await store.delete(snapshotKey);
  expect(getChatHistoryLoadState(state).phase).toBe("idle");
});

it.each([
  { reason: "branch-switch", eventOrder: "before" },
  { reason: "rewind", eventOrder: "after" },
] as const)(
  "follows $reason with exhausted history when its event arrives $eventOrder cache invalidation",
  async ({ reason, eventOrder }) => {
    vi.useRealTimers();
    vi.stubGlobal("indexedDB", new IDBFactory());
    installTranscriptDomMocks();
    onTestFinished(resetTranscriptTestDom);
    const row: GatewaySessionRow = {
      key: "agent:main:branch-history",
      agentId: "main",
      kind: "direct",
      updatedAt: 1,
      sessionId: "old-session",
      activeLeafEntryId: "old-leaf",
    };
    const replacement = {
      ...row,
      sessionId: "new-session",
      activeLeafEntryId: "new-leaf",
      updatedAt: 2,
    };
    const rows = [row];
    const selected = [
      nativeHistoryMessage(1, "selected prompt"),
      nativeHistoryMessage(2, "selected reply"),
    ];
    const readHistory = vi.fn(async (_method: string, raw: unknown) => {
      const params = asOptionalRecord(raw) ?? {};
      if (params.cursor && rows[0] === replacement) {
        return { kind: "reset" };
      }
      if (rows[0] === replacement) {
        return {
          messages: selected,
          hasMore: false,
          totalMessages: 2,
          deltaCursor: "new-cursor",
          sessionInfo: replacement,
        };
      }
      return {
        messages: (params.offset ? [1, 2, 3, 4] : [5, 6]).map((seq) => nativeHistoryMessage(seq)),
        hasMore: !params.offset,
        ...(params.offset ? {} : { nextOffset: 2, deltaCursor: "old-cursor" }),
        totalMessages: 6,
        sessionInfo: row,
      };
    });
    const mounted = createMountedPanes(rows, "main", undefined, {
      "chat.history": readHistory,
      "chat.startup": readHistory,
    });
    vi.spyOn(mounted.sessions, "listBranches").mockResolvedValue([]);
    await mounted.sessions.refresh({ agentId: "main", force: true });
    const follower = mounted.mount(row.key);
    const writer = mounted.mount(row.key);
    await Promise.all([follower, writer].map(refreshPane));
    follower.state.chatMessage = "unsent follower draft";
    await follower.loadOlderMessages();
    expect(follower.state.chatMessages).toHaveLength(6);
    expect(follower.state.chatHistoryPagination.hasMore).toBe(false);
    writer.state.chatMessagesBySession = new Map();
    const store = new SessionSnapshotStore(writer.state.chatMessagesBySession);
    store.connect();
    observeChatCache(writer.state.chatMessagesBySession, store);
    onTestFinished(async () => {
      store.disconnect();
      await store.whenIdle();
      await clearStoredChatSnapshots();
    });
    const broadcast = vi.spyOn(localStorage, "setItem");
    const emitChange = async () => {
      // Canonical list admission establishes the replacement physical session.
      await mounted.sessions.refresh({ agentId: "main", force: true });
      mounted.emitGatewayEvent("sessions.changed", {
        sessionKey: row.key,
        sessionId: replacement.sessionId,
        agentId: "main",
        reason,
        session: replacement,
      });
      const load = getChatHistoryLoadState(follower.state);
      if (load.phase === "in-flight") {
        await (load.refresh?.promise ?? load.promise);
      }
    };
    const mutate = async () => {
      rows[0] = replacement;
      if (eventOrder === "before") {
        await emitChange();
      }
      return {};
    };
    vi.spyOn(mounted.sessions, "switchBranch").mockImplementation(mutate);
    vi.spyOn(mounted.sessions, "rewind").mockImplementation(mutate);
    if (reason === "branch-switch") {
      expect(await switchChatHistoryBranch(writer.state, "new-leaf")).toBe(true);
    } else {
      expect(
        await rewindChatHistory(
          writer.state,
          "rewind-entry",
          new ChatAttachmentReadLifecycle(() => {}),
        ),
      ).not.toBeNull();
    }
    const invalidation = expectDefined(
      broadcast.mock.calls.findLast(
        ([name]) => name === "openclaw.control.chatSnapshots.invalidate.v1",
      )?.[1],
      "History invalidation broadcast",
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "openclaw.control.chatSnapshots.invalidate.v1",
        newValue: invalidation,
      }),
    );
    if (eventOrder === "after") {
      await emitChange();
    }
    expect(follower.state.chatMessages).toEqual(selected);
    expect(follower.state.currentSessionId).toBe("new-session");
    expect(follower.state.chatMessage).toBe("unsent follower draft");
    expect(follower.state.chatHistoryPagination.hasMore).toBe(false);
  },
);
