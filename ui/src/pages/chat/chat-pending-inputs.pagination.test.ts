/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ChatInputReceipts,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-outbox-admission.test-support.ts";
import {
  input,
  makeChatPageHost,
  page,
  sessionId,
  sessionKey,
} from "./chat-pending-inputs.test-support.ts";
import {
  applyChatPendingInputs,
  clearChatPendingInputs,
  getChatPendingInputs as pending,
  loadChatPendingInputs,
  readChatInputRunIds,
} from "./chat-pending-inputs.ts";
import { retireDeliveredQueuedUserTurn } from "./chat-send-support.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { renderChatView } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";
import { cacheChatSessionSnapshot, type ChatMessageCache } from "./session-message-cache.ts";

beforeEach(() => {
  installTranscriptDomMocks();
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

const pendingScope = { sessionKey, currentSessionId: sessionId };
function historyHost(history: unknown, chatQueue: ChatQueueItem[] = []) {
  return makeChatHost({ ...pendingScope, chatQueue, requestHandlers: { "chat.history": history } });
}
function queueView(host: ChatState, messages: unknown[] = []) {
  return renderChatView({ historyState: host, sessionKey, messages });
}
function queueTexts(host: ChatState, messages?: unknown[]) {
  return Array.from(
    queueView(host, messages).querySelectorAll(".chat-queue__text"),
    (row) => row.textContent,
  );
}

function queuedInput(id: string, acceptedAt: number, messageId?: string, content = id) {
  return {
    ...input,
    id,
    runId: id,
    acceptedAt,
    state: "queued",
    queued: true,
    message: { role: "user", content, ...(messageId ? { __openclaw: { id: messageId } } : {}) },
  } satisfies ChatPendingInputsPage["items"][number];
}
function browserInput(id: string, overrides: Partial<ChatQueueItem> = {}): ChatQueueItem {
  return {
    id,
    text: id,
    createdAt: 100,
    sendRunId: id,
    sendState: "waiting-reconnect",
    ...overrides,
  };
}
function admitBrowserInput(host: ChatState, item: ChatQueueItem) {
  expect(
    admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), item),
  ).toBe(true);
}

it.each([
  ["empty-queue", 0, []],
  ["complete-page", 1, ["replacement"]],
  ["partial-page-receipts", 2, ["retained", "replacement"]],
] as const)(
  "retires consumed server queue chips outside the transcript window using %s",
  async (source, queuedCount, expected) => {
    const consumed = queuedInput("consumed", 1);
    const retained = queuedInput("retained", 2);
    const replacement = queuedInput("replacement", 3);
    let pendingInputs: ChatPendingInputsPage = {
      items: [consumed, retained],
      total: 2,
      queuedCount: 2,
    };
    let inputReceipts: ChatInputReceipts | undefined = undefined;
    const host = historyHost(() => ({
      sessionId,
      // Consumption happened outside this retained transcript window.
      messages: [{ role: "assistant", content: "Recent activity only" }],
      pendingInputs,
      ...(inputReceipts ? { inputReceipts } : {}),
    }));
    await loadChatHistory(host);
    expect(queueTexts(host, host.chatMessages)).toEqual(["consumed", "retained"]);

    // A partial page alone cannot retire either previously observed input.
    pendingInputs = { items: [], total: 21, nextBefore: 21, queuedCount: 2 };
    await loadChatHistory(host);
    expect(queueTexts(host, host.chatMessages)).toEqual(["consumed", "retained"]);

    pendingInputs = {
      items: queuedCount ? [replacement] : [],
      total: queuedCount === 1 ? 1 : 21,
      queuedCount,
      ...(queuedCount === 1 ? {} : { nextBefore: 21 }),
    };
    // Complete queue snapshots stand alone; partial pages need exact receipts
    // because ordinary consumption deletes its custody record.
    inputReceipts =
      source === "partial-page-receipts"
        ? [{ runId: retained.runId, state: "pending", queued: true }]
        : undefined;
    await loadChatHistory(host);

    expect(queueTexts(host, host.chatMessages)).toEqual(expected);
    expect(readChatInputRunIds(host)).not.toContain(consumed.runId);
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  },
);

it("refreshes every live queued input across receipt batches without reordering the shelf", async () => {
  const inputs = Array.from({ length: 51 }, (_, index) => queuedInput(`queued-${index}`, index));
  const host = historyHost(
    (params: { inputRunIds?: string[] }) => ({
      sessionId,
      messages: [],
      pendingInputs: { items: [], total: 71, nextBefore: 21 },
      inputReceipts: params.inputRunIds?.map((runId) =>
        runId === "browser-input"
          ? { runId, state: "consumed", consumedByEventId: "browser-result" }
          : { runId, state: "pending", ...(runId === "queued-50" ? {} : { queued: true }) },
      ),
    }),
    [
      browserInput("browser-input", {
        createdAt: 99,
        sendAttempts: 1,
        sendState: "unconfirmed",
      }),
    ],
  );
  for (let offset = 0; offset < inputs.length; offset += 20) {
    applyChatPendingInputs(host, { items: inputs.slice(offset, offset + 20), total: 71 });
  }
  await loadChatHistory(host);
  expect(queueTexts(host).slice(0, inputs.length)).toEqual(
    inputs.map((item) => item.message.content),
  );
  await loadChatHistory(host);
  expect(queueTexts(host)).toEqual(inputs.slice(0, 50).map((item) => item.message.content));
  expect(host.chatQueue).toEqual([]);
});

it("discovers the whole live queue without changing the visible history page", async () => {
  const oldest = queuedInput("old", 1, "pending:old");
  const newest = queuedInput("new", 2, "pending:new");
  const latestPage = { items: [newest], total: 21, nextBefore: 21, queuedCount: 2 };
  const host = historyHost((params: { pendingBefore?: number }) => ({
    sessionId,
    messages: [],
    pendingInputs:
      params.pendingBefore === 21 ? { items: [oldest], total: 21, queuedCount: 2 } : latestPage,
  }));
  applyChatPendingInputs(host, { items: [], total: 0 });
  await loadChatPendingInputs(host);
  expect(pending(host)?.page).toEqual(latestPage);
  expect(pending(host)?.before).toBeUndefined();
  expect(
    pending(host)
      ?.queuedInputs.map((item) => item.runId)
      .toSorted(),
  ).toEqual(["new", "old"]);
  expect(queueView(host).querySelectorAll(".chat-queue__item")).toHaveLength(2);
  expect(host.request).toHaveBeenCalledTimes(2);
});

it("discovers and retains a live queue beyond the latest page until an exact receipt retires it", async () => {
  let queued = true;
  const host = historyHost((params: { pendingBefore?: number; inputRunIds?: string[] }) => ({
    sessionId,
    messages: [],
    pendingInputs:
      params.pendingBefore === 21
        ? {
            items: [
              {
                ...input,
                state: queued ? "queued" : "cancelled",
                ...(queued ? { queued: true } : {}),
              },
            ],
            total: 21,
          }
        : { items: [], total: 21, nextBefore: 21 },
    inputReceipts: params.inputRunIds?.some((runId) => runId === input.runId)
      ? [{ runId: input.runId, state: "pending", ...(queued ? { queued: true } : {}) }]
      : [],
  }));
  applyChatPendingInputs(host, { items: [], total: 21, nextBefore: 21 });
  await loadChatPendingInputs(host, 21);
  applyChatPendingInputs(host, { items: [], total: 21, nextBefore: 21 });
  expect(readChatInputRunIds(host)).toContain(input.runId);
  await loadChatHistory(host);
  expect(host.request).toHaveBeenCalledWith(
    "chat.history",
    expect.objectContaining({ inputRunIds: [input.runId] }),
  );
  expect(queueView(host).querySelector(".chat-queue__text")?.textContent).toBe(
    "Keep my accepted input",
  );
  queued = false;
  await loadChatHistory(host);
  expect(queueView(host).querySelector(".chat-queue__item")).toBeNull();
  expect(readChatInputRunIds(host)).not.toContain(input.runId);
});

it.each([
  { delivery: "page", order: "pagination-first" },
  { delivery: "delta", order: "refresh-first" },
])(
  "preserves pending-input navigation through a $delivery refresh ($order)",
  async ({ delivery, order }) => {
    const navigation = createDeferred<unknown>();
    const refresh = createDeferred<unknown>();
    const canonical = {
      role: "user",
      content: "Canonical transcript stays visible",
      __openclaw: { id: "canonical", seq: 1 },
    };
    const newest = {
      ...queuedInput("latest-input", 100, "pending:latest-input"),
      runId: "latest-run",
    };
    const latestPage: ChatPendingInputsPage = { items: [newest], total: 21, nextBefore: 21 };
    const refreshedLatestPage: ChatPendingInputsPage = {
      ...latestPage,
      items: [
        {
          ...queuedInput("newer-input", 100, undefined, "New queued input"),
          runId: "newer-run",
        },
      ],
    };
    const olderPage: ChatPendingInputsPage = { items: [input], total: 21 };
    const refreshedOlderPage: ChatPendingInputsPage = {
      items: [{ ...input, state: "cancelled" }],
      total: 21,
    };
    const cache: ChatMessageCache = new Map();
    let olderReads = 0;
    let refreshFinished = false;
    const host = makeChatPageHost({
      ...pendingScope,
      chatRunId: "active-run",
      chatStream: "Live output",
      chatMessages: [canonical],
      chatHistoryPagination: { hasMore: false, completeSnapshot: true },
      chatMessagesBySession: cache,
      requestHandlers: {
        "chat.history": (params: { pendingBefore?: number }) =>
          params.pendingBefore === 21
            ? ++olderReads === 1
              ? navigation.promise
              : { sessionId, pendingInputs: refreshedOlderPage }
            : refreshFinished
              ? { sessionId, pendingInputs: refreshedLatestPage }
              : refresh.promise,
      },
    });
    cacheChatSessionSnapshot(
      cache,
      host,
      { sessionKey },
      {
        messages: [canonical],
        sessionId,
        pagination: host.chatHistoryPagination,
        ...(delivery === "delta" ? { deltaCursor: "previous" } : {}),
      },
    );
    const consumedSource = browserInput("consumed-source", {
      sessionKey,
      sessionId,
      createdAt: 101,
      sendAttempts: 1,
    });
    admitBrowserInput(host, consumedSource);
    const outbox = expectDefined(listStoredChatOutboxes(host)[0], "retained input outbox");
    expect(
      await retireDeliveredQueuedUserTurn(host, consumedSource.sendRunId, outbox, {
        retainUntilConsumed: true,
      }),
    ).toBe("retained");
    expect(listStoredChatOutboxes(host)[0]?.queue.map((item) => item.id)).toEqual([
      consumedSource.id,
    ]);
    expect(host.chatMessages).toHaveLength(2);
    applyChatPendingInputs(host, latestPage);
    const paging = loadChatPendingInputs(host, 21);
    if (order === "pagination-first") {
      navigation.resolve({ sessionId, pendingInputs: olderPage });
      await paging;
      expect(pending(host)?.before).toBe(21);
    }

    handlePageGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey, agentId: "main", reason: "send", hasActiveRun: true },
    });
    const refreshing = loadChatHistory(host, { deferBranches: true });
    refresh.resolve({
      ...(delivery === "delta"
        ? { kind: "delta", deltaCursor: "next", messages: [] }
        : { sessionId, messages: [canonical] }),
      sessionInfo: { key: sessionKey, sessionId, hasActiveRun: true, status: "running" },
      pendingInputs: refreshedLatestPage,
      inputReceipts: [
        { runId: "consumed-source", state: "consumed", consumedByEventId: "aggregate" },
        { runId: "latest-run", state: "consumed", consumedByEventId: "latest-input" },
      ],
    });
    await refreshing;
    refreshFinished = true;
    if (order === "refresh-first") {
      navigation.resolve({ sessionId, pendingInputs: olderPage });
      await paging;
    }

    await vi.waitFor(() => {
      expect(pending(host)?.before).toBe(21);
      expect(pending(host)?.page).toEqual(
        order === "refresh-first" ? olderPage : refreshedOlderPage,
      );
    });
    expect(host.chatMessages).toEqual([canonical]);
    expect(host.chatQueue).toEqual([]);
    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(host).toMatchObject({ chatRunId: "active-run", chatStream: "Live output" });
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    const container = queueView(host, host.chatMessages);
    expect(container.querySelector(".chat-queue__text")?.textContent).toBe("New queued input");
    expect(readChatInputRunIds(host)).toContain("newer-run");
    expect(readChatInputRunIds(host)).not.toContain("latest-run");

    await loadChatPendingInputs(host);
    expect(pending(host)?.before).toBeUndefined();
    expect(pending(host)?.page).toEqual(refreshedLatestPage);
  },
);

it.each(["refresh-first", "latest-first"])(
  "lets latest navigation replace a coalesced background custody refresh (%s)",
  async (order) => {
    const refresh = createDeferred<unknown>();
    const latest = createDeferred<unknown>();
    const olderPage: ChatPendingInputsPage = { items: [input], total: 2 };
    const latestPage: ChatPendingInputsPage = { items: [], total: 0 };
    let olderReads = 0;
    const host = historyHost((params: { pendingBefore?: number }) =>
      params.pendingBefore === 2
        ? ++olderReads === 1
          ? { sessionId, pendingInputs: olderPage }
          : refresh.promise
        : latest.promise,
    );
    admitBrowserInput(
      host,
      browserInput("retained-source", {
        sessionKey,
        sessionId,
        sendRunId: input.runId,
        text: "Retained payload",
      }),
    );
    applyChatPendingInputs(host, page);
    await loadChatPendingInputs(host, 2);

    for (let index = 0; index < 3; index++) {
      applyChatPendingInputs(host, latestPage);
    }
    expect(olderReads).toBe(2);
    expect(pending(host)).toMatchObject({ loading: false, before: 2 });
    const showLatest = loadChatPendingInputs(host);
    const settleRefresh = async () => {
      refresh.resolve({
        sessionId,
        pendingInputs: { items: [{ ...input, state: "cancelled" }], total: 1 },
      });
      // Let the superseded transport response finish without observing private request state.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    };
    if (order === "refresh-first") {
      await settleRefresh();
      expect(pending(host)?.loading).toBe(true);
    }
    latest.resolve({ sessionId, pendingInputs: latestPage });
    await showLatest;
    if (order === "latest-first") {
      await settleRefresh();
    }

    expect(pending(host)?.page).toEqual(latestPage);
    expect(pending(host)).toMatchObject({ before: undefined, loading: false });
    expect(host.chatQueue.some((item) => item.id === "retained-source")).toBe(true);
    expect(olderReads).toBe(2);
  },
);

it.each(["session", "connection", "source"])(
  "stops invalidated custody rereads after the %s changes",
  async (change) => {
    const response = createDeferred<unknown>();
    const host = historyHost(() => response.promise);
    const history = [{ role: "user", content: "Canonical history" }];
    host.chatMessages = history;
    applyChatPendingInputs(host, page);
    const paging = loadChatPendingInputs(host, 2);
    expect(host.request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ pendingBefore: 2 }),
    );
    if (change !== "session") {
      applyChatPendingInputs(host, page);
    }
    if (change === "session") {
      host.currentSessionId = "replacement-session";
    } else if (change === "connection") {
      host.connectionEpoch += 1;
    } else {
      clearChatPendingInputs(host);
      applyChatPendingInputs(host, page);
    }
    response.resolve({
      sessionId,
      pendingInputs: { items: [], total: change === "session" ? 2 : 0 },
    });
    await paging;
    expect(host.chatMessages).toBe(history);
    if (change === "session") {
      expect(pending(host)).toBeUndefined();
    } else {
      expect(pending(host)?.page).toEqual(page);
      expect(pending(host)).toMatchObject({ before: undefined, loading: false });
    }
    expect(host.request).toHaveBeenCalledTimes(1);
  },
);

it("keeps the displayed custody page and reports a failed navigation without retrying", async () => {
  const response = createDeferred<unknown>();
  const olderPage: ChatPendingInputsPage = { items: [input], total: 2 };
  const host = historyHost((params: { pendingBefore?: number }) =>
    params.pendingBefore === 2 ? { sessionId, pendingInputs: olderPage } : response.promise,
  );
  applyChatPendingInputs(host, page);
  await loadChatPendingInputs(host, 2);
  const paging = loadChatPendingInputs(host);
  applyChatPendingInputs(host, page);
  response.reject(new Error("Could not load latest messages"));
  await paging;

  expect(pending(host)?.page).toEqual(olderPage);
  expect(pending(host)?.before).toBe(2);
  expect(pending(host)?.error).toContain("Could not load latest messages");
  expect(pending(host)?.loading).toBe(false);
  expect(host.request).toHaveBeenCalledTimes(2);
});
