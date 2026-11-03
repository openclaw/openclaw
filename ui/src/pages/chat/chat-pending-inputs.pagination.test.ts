/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatInputReceipts,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
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
  getChatPendingInputs,
  loadChatPendingInputs,
  readChatInputRunIds,
} from "./chat-pending-inputs.ts";
import { retireDeliveredQueuedUserTurn } from "./chat-send-support.ts";
import { handlePageGatewayEvent } from "./chat-state-events.test-support.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { renderChatView } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { cacheChatSessionSnapshot } from "./session-message-cache.ts";

beforeEach(() => {
  installTranscriptDomMocks();
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

function queuedInput(id: string, acceptedAt: number, messageId?: string, runId = id) {
  return {
    ...input,
    id,
    runId,
    acceptedAt,
    state: "queued",
    queued: true,
    message: { role: "user", content: id, ...(messageId ? { __openclaw: { id: messageId } } : {}) },
  } satisfies ChatPendingInputsPage["items"][number];
}

function makeHost(history: unknown, overrides: Parameters<typeof makeChatHost>[0] = {}) {
  return makeChatHost({
    sessionKey,
    currentSessionId: sessionId,
    requestHandlers: { "chat.history": history },
    ...overrides,
  });
}

function retainedSource(id: string, sendRunId = id): ChatQueueItem {
  return {
    id,
    sendRunId,
    sessionKey,
    sessionId,
    text: "Retained payload",
    createdAt: 100,
    sendAttempts: 1,
    sendState: "waiting-reconnect",
  };
}

async function queueText(host: Parameters<typeof loadChatHistory>[0]) {
  const container = renderChatView({
    historyState: host,
    sessionKey,
    messages: host.chatMessages,
  });
  await vi.dynamicImportSettled();
  flush();
  return Array.from(container.querySelectorAll(".chat-queue__text"), (row) => row.textContent);
}

function expectPage(
  host: Parameters<typeof getChatPendingInputs>[0],
  expected: ChatPendingInputsPage,
  before?: number,
) {
  const view = getChatPendingInputs(host);
  expect(view?.page).toEqual(expected);
  expect(view?.before).toBe(before);
  expect(view?.loading).toBe(false);
}

describe("server-owned pending input pagination", () => {
  it.each(["empty-queue", "complete-page", "partial-page-receipts"] as const)(
    "retires consumed server queue chips outside the transcript window using %s",
    async (source) => {
      const consumed = queuedInput("Already handled while disconnected", 1);
      const retained = queuedInput("Still waiting on the server", 2);
      const replacement = queuedInput("New request from another participant", 3);
      let pendingInputs: ChatPendingInputsPage = {
        items: [consumed, retained],
        total: 2,
        queuedCount: 2,
      };
      let inputReceipts: ChatInputReceipts | undefined = undefined;
      const host = makeHost(() => ({
        sessionId,
        // Consumption happened outside this retained transcript window.
        messages: [{ role: "assistant", content: "Recent activity only" }],
        pendingInputs,
        ...(inputReceipts ? { inputReceipts } : {}),
      }));
      await loadChatHistory(host);
      expect(await queueText(host)).toEqual([consumed.message.content, retained.message.content]);

      // A partial page alone cannot retire either previously observed input.
      pendingInputs = { items: [], total: 21, nextBefore: 21, queuedCount: 2 };
      await loadChatHistory(host);
      expect(await queueText(host)).toEqual([consumed.message.content, retained.message.content]);

      pendingInputs =
        source === "empty-queue"
          ? { items: [], total: 21, nextBefore: 21, queuedCount: 0 }
          : {
              items: [replacement],
              total: source === "complete-page" ? 1 : 21,
              queuedCount: source === "complete-page" ? 1 : 2,
              ...(source === "partial-page-receipts" ? { nextBefore: 21 } : {}),
            };
      // Complete queue snapshots stand alone; partial pages need exact receipts
      // because ordinary consumption deletes its custody record.
      inputReceipts =
        source === "partial-page-receipts"
          ? [{ runId: retained.runId, state: "pending", queued: true }]
          : undefined;
      await loadChatHistory(host);

      expect(await queueText(host)).toEqual(
        source === "empty-queue"
          ? []
          : source === "complete-page"
            ? [replacement.message.content]
            : [retained.message.content, replacement.message.content],
      );
      expect(readChatInputRunIds(host)).not.toContain(consumed.runId);
      expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    },
  );

  it("refreshes every live queued input across receipt batches without reordering the shelf", async () => {
    const inputs = Array.from({ length: 51 }, (_, index) => queuedInput(`queued-${index}`, index));
    const host = makeHost(
      (params: { inputRunIds?: string[] }) => ({
        sessionId,
        messages: [],
        pendingInputs: { items: [], total: 71, nextBefore: 21 },
        inputReceipts: params.inputRunIds?.map((runId) =>
          runId === "browser-input"
            ? { runId, state: "consumed", consumedByEventId: "browser-result" }
            : {
                runId,
                state: "pending",
                ...(runId === "queued-50" ? {} : { queued: true }),
              },
        ),
      }),
      { chatQueue: [retainedSource("browser-input")] },
    );
    for (let offset = 0; offset < inputs.length; offset += 20) {
      applyChatPendingInputs(host, { items: inputs.slice(offset, offset + 20), total: 71 });
    }
    await loadChatHistory(host);
    expect((await queueText(host)).slice(0, inputs.length)).toEqual(
      inputs.map((item) => item.message.content),
    );
    await loadChatHistory(host);
    expect(await queueText(host)).toEqual(inputs.slice(0, 50).map((item) => item.message.content));
    expect(host.chatQueue).toEqual([]);
  });

  it("discovers the whole queue without changing pages and retains it until an exact receipt", async () => {
    let queued = true;
    const oldest = queuedInput("old", 1, "pending:old");
    const newest = queuedInput("new", 2, "pending:new");
    const latestPage = { items: [newest], total: 21, nextBefore: 21, queuedCount: 2 };
    const host = makeHost((params: { pendingBefore?: number; inputRunIds?: string[] }) => ({
      sessionId,
      messages: [],
      pendingInputs:
        params.pendingBefore === 21 ? { items: [oldest], total: 21, queuedCount: 2 } : latestPage,
      inputReceipts: params.inputRunIds?.map((runId) => ({
        runId,
        state: "pending",
        ...(runId !== oldest.runId || queued ? { queued: true } : {}),
      })),
    }));
    applyChatPendingInputs(host, { items: [], total: 0 });
    await loadChatPendingInputs(host);
    expectPage(host, latestPage);
    expect(await queueText(host)).toEqual(["old", "new"]);
    expect(host.request).toHaveBeenCalledTimes(2);
    applyChatPendingInputs(host, latestPage);
    expect(readChatInputRunIds(host)).toContain(oldest.runId);
    await loadChatHistory(host);
    expect(await queueText(host)).toEqual(["old", "new"]);
    queued = false;
    latestPage.queuedCount = 1;
    await loadChatHistory(host);
    expect(await queueText(host)).toEqual(["new"]);
    expect(readChatInputRunIds(host)).not.toContain(oldest.runId);
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
        content: "Canonical",
        __openclaw: { id: "canonical", seq: 1 },
      };
      const latestPage: ChatPendingInputsPage = {
        items: [
          queuedInput("latest-input", input.acceptedAt, "pending:latest-input", "latest-run"),
        ],
        total: 21,
        nextBefore: 21,
      };
      const refreshedLatestPage: ChatPendingInputsPage = {
        ...latestPage,
        items: [queuedInput("newer-input", input.acceptedAt, undefined, "newer-run")],
      };
      const olderPage: ChatPendingInputsPage = { items: [input], total: 21 };
      const refreshedOlderPage: ChatPendingInputsPage = {
        items: [{ ...input, state: "cancelled" }],
        total: 21,
      };
      let olderReads = 0;
      let refreshFinished = false;
      const host = makeChatPageHost({
        sessionKey,
        currentSessionId: sessionId,
        chatRunId: "active-run",
        chatStream: "Live output",
        chatMessages: [canonical],
        chatHistoryPagination: { hasMore: false, completeSnapshot: true },
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
        host.chatMessagesBySession,
        host,
        { sessionKey },
        {
          messages: [canonical],
          sessionId,
          pagination: host.chatHistoryPagination,
          ...(delivery === "delta" ? { deltaCursor: "previous" } : {}),
        },
      );
      const consumedSource = retainedSource("consumed-source");
      expect(
        admitQueuedMessageForSession(
          host,
          captureChatOutboxAdmission(host, sessionKey),
          consumedSource,
        ),
      ).toBe(true);
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
        expect(getChatPendingInputs(host)?.before).toBe(21);
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
        expect(getChatPendingInputs(host)?.before).toBe(21);
        expect(getChatPendingInputs(host)?.page).toEqual(
          order === "refresh-first" ? olderPage : refreshedOlderPage,
        );
      });
      expect(host.chatMessages).toEqual([canonical]);
      expect(host.chatQueue).toEqual([]);
      expect(listStoredChatOutboxes(host)).toEqual([]);
      expect(host).toMatchObject({ chatRunId: "active-run", chatStream: "Live output" });
      expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
      expect(await queueText(host)).toEqual(["newer-input"]);
      expect(readChatInputRunIds(host)).toContain("newer-run");
      expect(readChatInputRunIds(host)).not.toContain("latest-run");

      await loadChatPendingInputs(host);
      expect(getChatPendingInputs(host)?.before).toBeUndefined();
      expect(getChatPendingInputs(host)?.page).toEqual(refreshedLatestPage);
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
      const host = makeHost((params: { pendingBefore?: number }) =>
        params.pendingBefore === 2
          ? ++olderReads === 1
            ? { sessionId, pendingInputs: olderPage }
            : refresh.promise
          : latest.promise,
      );
      expect(
        admitQueuedMessageForSession(
          host,
          captureChatOutboxAdmission(host, sessionKey),
          retainedSource("retained-source", input.runId),
        ),
      ).toBe(true);
      applyChatPendingInputs(host, page);
      await loadChatPendingInputs(host, 2);
      expect(host.chatQueue.some((item) => item.id === "retained-source")).toBe(false);

      for (let index = 0; index < 3; index++) {
        applyChatPendingInputs(host, latestPage);
      }
      expect(olderReads).toBe(2);
      expect(getChatPendingInputs(host)?.loading).toBe(false);
      expect(getChatPendingInputs(host)?.before).toBe(2);
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
        expect(getChatPendingInputs(host)?.loading).toBe(true);
      }
      latest.resolve({ sessionId, pendingInputs: latestPage });
      await showLatest;
      if (order === "latest-first") {
        await settleRefresh();
      }

      expectPage(host, latestPage);
      expect(host.chatQueue.some((item) => item.id === "retained-source")).toBe(false);
      expect(olderReads).toBe(2);
    },
  );

  it.each(["session", "connection", "source"])(
    "stops invalidated custody rereads after the %s changes",
    async (change) => {
      const response = createDeferred<unknown>();
      const host = makeHost(() => response.promise);
      const history = [{ role: "user", content: "Canonical history" }];
      host.chatMessages = history;
      applyChatPendingInputs(host, page);
      const paging = loadChatPendingInputs(host, 2);
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
        expect(getChatPendingInputs(host)).toBeUndefined();
      } else {
        expectPage(host, page);
      }
      expect(host.request).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the displayed custody page and reports a failed navigation without retrying", async () => {
    const response = createDeferred<unknown>();
    const olderPage: ChatPendingInputsPage = { items: [input], total: 2 };
    const host = makeHost((params: { pendingBefore?: number }) =>
      params.pendingBefore === 2 ? { sessionId, pendingInputs: olderPage } : response.promise,
    );
    applyChatPendingInputs(host, page);
    await loadChatPendingInputs(host, 2);
    const paging = loadChatPendingInputs(host);
    applyChatPendingInputs(host, page);
    response.reject(new Error("Could not load latest messages"));
    await paging;

    expectPage(host, olderPage, 2);
    expect(getChatPendingInputs(host)?.error).toContain("Could not load latest messages");
    expect(
      renderChatView({ historyState: host, sessionKey }).querySelector(".chat-footer")?.textContent,
    ).toContain("Could not load latest messages");
    expect(host.request).toHaveBeenCalledTimes(2);
  });
});
