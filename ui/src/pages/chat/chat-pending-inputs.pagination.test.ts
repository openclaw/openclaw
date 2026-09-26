/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
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
import { admitQueuedMessageForSession } from "./chat-queue.ts";
import { retireDeliveredQueuedUserTurn } from "./chat-send-support.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
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
  resetTranscriptTestDom();
});

describe("server-owned pending input pagination", () => {
  it("refreshes every live queued input across receipt batches without reordering the shelf", async () => {
    const inputs = Array.from({ length: 51 }, (_, index) => ({
      ...input,
      id: `queued-${index}`,
      runId: `queued-${index}`,
      acceptedAt: index,
      state: "queued" as const,
      queued: true as const,
      message: { role: "user", content: `Queued message ${index}` },
    }));
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      chatQueue: [
        {
          id: "browser-input",
          text: "Unconfirmed browser input",
          createdAt: 99,
          sendRunId: "browser-input",
          sendAttempts: 1,
          sendState: "unconfirmed",
        },
      ],
      requestHandlers: {
        "chat.history": (params: { inputRunIds?: string[] }) => ({
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
      },
    });
    for (let offset = 0; offset < inputs.length; offset += 20) {
      applyChatPendingInputs(host, { items: inputs.slice(offset, offset + 20), total: 71 });
    }
    const queueText = () =>
      Array.from(
        renderChatView({ historyState: host, sessionKey }).querySelectorAll(".chat-queue__text"),
        (row) => row.textContent,
      );
    await loadChatHistory(host);
    expect(queueText().slice(0, inputs.length)).toEqual(inputs.map((item) => item.message.content));
    await loadChatHistory(host);
    expect(queueText()).toEqual(inputs.slice(0, 50).map((item) => item.message.content));
    expect(host.chatQueue).toEqual([]);
  });

  it("discovers the whole live queue without changing the visible history page", async () => {
    const queuedInput = (id: string, acceptedAt: number) => ({
      ...input,
      id,
      runId: id,
      acceptedAt,
      state: "queued" as const,
      queued: true as const,
      message: { role: "user", content: id, __openclaw: { id: `pending:${id}` } },
    });
    const oldest = queuedInput("old", 1);
    const newest = queuedInput("new", 2);
    const latestPage = { items: [newest], total: 21, nextBefore: 21, queuedCount: 2 };
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: {
        "chat.history": (params: { pendingBefore?: number }) => ({
          sessionId,
          messages: [],
          pendingInputs:
            params.pendingBefore === 21
              ? { items: [oldest], total: 21, queuedCount: 2 }
              : latestPage,
        }),
      },
    });
    applyChatPendingInputs(host, { items: [], total: 0 });
    await loadChatPendingInputs(host);
    expect(getChatPendingInputs(host)?.page).toEqual(latestPage);
    expect(getChatPendingInputs(host)?.before).toBeUndefined();
    expect(
      getChatPendingInputs(host)
        ?.queuedInputs.map((item) => item.runId)
        .toSorted(),
    ).toEqual(["new", "old"]);
    expect(
      renderChatView({ historyState: host, sessionKey }).querySelectorAll(".chat-queue__item"),
    ).toHaveLength(2);
    expect(host.request).toHaveBeenCalledTimes(2);
  });

  it("discovers and retains a live queue beyond the latest page until an exact receipt retires it", async () => {
    let queued = true;
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: {
        "chat.history": (params: { pendingBefore?: number; inputRunIds?: string[] }) => ({
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
        }),
      },
    });
    applyChatPendingInputs(host, { items: [], total: 21, nextBefore: 21 });
    await loadChatPendingInputs(host, 21);
    applyChatPendingInputs(host, { items: [], total: 21, nextBefore: 21 });
    expect(readChatInputRunIds(host)).toContain(input.runId);
    await loadChatHistory(host);
    expect(host.request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ inputRunIds: [input.runId] }),
    );
    expect(
      renderChatView({ historyState: host, sessionKey }).querySelector(".chat-queue__text")
        ?.textContent,
    ).toBe("Keep my accepted input");
    queued = false;
    await loadChatHistory(host);
    expect(
      renderChatView({ historyState: host, sessionKey }).querySelector(".chat-queue__item"),
    ).toBeNull();
    expect(readChatInputRunIds(host)).not.toContain(input.runId);
  });

  it("pages custody without replacing transcript or applying a stale physical-session response", async () => {
    let resolve!: (value: unknown) => void;
    const response = new Promise((done) => {
      resolve = done;
    });
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: { "chat.history": () => response },
    });
    const history = [{ role: "user", content: "Canonical history" }];
    host.chatMessages = history;
    applyChatPendingInputs(host, page);
    const loading = loadChatPendingInputs(host, 2);
    expect(host.request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ pendingBefore: 2 }),
    );
    host.currentSessionId = "replacement-session";
    resolve({ sessionId, pendingInputs: { items: [], total: 2 } });
    await loading;
    expect(host.chatMessages).toBe(history);
    expect(getChatPendingInputs(host)).toBeUndefined();
    expect(host.request).toHaveBeenCalledTimes(1);
  });

  it.each(
    ["page", "delta"].flatMap((delivery) =>
      ["pagination-first", "refresh-first"].map((order) => ({ delivery, order })),
    ),
  )(
    "preserves pending-input navigation through a $delivery refresh ($order)",
    async ({ delivery, order }) => {
      const navigation = createDeferred<unknown>();
      const refresh = createDeferred<unknown>();
      const canonical = {
        role: "user",
        content: "Canonical transcript stays visible",
        __openclaw: { id: "canonical", seq: 1 },
      };
      const latestPage: ChatPendingInputsPage = {
        items: [
          {
            ...input,
            id: "latest-input",
            runId: "latest-run",
            queued: true,
            state: "queued",
            message: {
              role: "user",
              content: "Newest retained input",
              timestamp: 100,
              __openclaw: { id: "pending:latest-input" },
            },
          },
        ],
        total: 21,
        nextBefore: 21,
      };
      const refreshedLatestPage: ChatPendingInputsPage = {
        ...latestPage,
        items: [
          {
            ...latestPage.items[0]!,
            id: "newer-input",
            runId: "newer-run",
            message: { role: "user", content: "New queued input" },
          },
        ],
      };
      const olderPage: ChatPendingInputsPage = { items: [input], total: 21 };
      const refreshedOlderPage: ChatPendingInputsPage = {
        items: [{ ...input, state: "cancelled" }],
        total: 21,
      };
      const sessionInfo = {
        key: sessionKey,
        sessionId,
        hasActiveRun: true,
        status: "running",
      };
      const cache: ChatMessageCache = new Map();
      let olderReads = 0;
      let refreshFinished = false;
      const host = makeChatPageHost({
        sessionKey,
        currentSessionId: sessionId,
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
      const consumedSource: ChatQueueItem = {
        id: "consumed-source",
        sendRunId: "consumed-source",
        sessionKey,
        sessionId,
        text: "Locally retained until consumption",
        createdAt: 101,
        sendAttempts: 1,
        sendState: "waiting-reconnect",
      };
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
        sessionInfo,
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
        expect(getChatPendingInputs(host)?.page).toEqual(refreshedOlderPage);
      });
      expect(host.chatMessages).toEqual([canonical]);
      expect(host.chatQueue).toEqual([]);
      expect(listStoredChatOutboxes(host)).toEqual([]);
      expect(host.chatRunId).toBe("active-run");
      expect(host.chatStream).toBe("Live output");
      expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
      const container = renderChatView({
        historyState: host,
        sessionKey,
        messages: host.chatMessages,
        queue: host.chatQueue,
      });
      expect(container.querySelector(".chat-queue__text")?.textContent).toBe("New queued input");
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
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        requestHandlers: {
          "chat.history": (params: { pendingBefore?: number }) =>
            params.pendingBefore === 2
              ? ++olderReads === 1
                ? { sessionId, pendingInputs: olderPage }
                : refresh.promise
              : latest.promise,
        },
      });
      expect(
        admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
          id: "retained-source",
          sendRunId: input.runId,
          sessionKey,
          sessionId,
          text: "Retained payload",
          createdAt: 100,
          sendState: "waiting-reconnect",
        }),
      ).toBe(true);
      applyChatPendingInputs(host, page);
      await loadChatPendingInputs(host, 2);

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

      expect(getChatPendingInputs(host)?.page).toEqual(latestPage);
      expect(getChatPendingInputs(host)?.before).toBeUndefined();
      expect(getChatPendingInputs(host)?.loading).toBe(false);
      expect(host.chatQueue.some((item) => item.id === "retained-source")).toBe(true);
      expect(olderReads).toBe(2);
    },
  );

  it.each(["connection", "source"])(
    "stops invalidated custody rereads after the %s changes",
    async (change) => {
      const response = createDeferred<unknown>();
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        requestHandlers: { "chat.history": () => response.promise },
      });
      applyChatPendingInputs(host, page);
      const paging = loadChatPendingInputs(host, 2);
      applyChatPendingInputs(host, page);
      if (change === "connection") {
        host.connectionEpoch += 1;
      } else {
        clearChatPendingInputs(host);
        applyChatPendingInputs(host, page);
      }
      response.resolve({ sessionId, pendingInputs: { items: [], total: 0 } });
      await paging;

      expect(getChatPendingInputs(host)?.page).toEqual(page);
      expect(getChatPendingInputs(host)?.before).toBeUndefined();
      expect(getChatPendingInputs(host)?.loading).toBe(false);
      expect(host.request).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the displayed custody page and reports a failed navigation without retrying", async () => {
    const response = createDeferred<unknown>();
    const olderPage: ChatPendingInputsPage = { items: [input], total: 2 };
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: {
        "chat.history": (params: { pendingBefore?: number }) =>
          params.pendingBefore === 2 ? { sessionId, pendingInputs: olderPage } : response.promise,
      },
    });
    applyChatPendingInputs(host, page);
    await loadChatPendingInputs(host, 2);
    const paging = loadChatPendingInputs(host);
    applyChatPendingInputs(host, page);
    response.reject(new Error("Could not load latest messages"));
    await paging;

    expect(getChatPendingInputs(host)?.page).toEqual(olderPage);
    expect(getChatPendingInputs(host)?.before).toBe(2);
    expect(getChatPendingInputs(host)?.error).toContain("Could not load latest messages");
    expect(getChatPendingInputs(host)?.loading).toBe(false);
    expect(host.request).toHaveBeenCalledTimes(2);
  });
});
