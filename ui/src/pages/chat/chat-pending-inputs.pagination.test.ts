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
  it("keeps the last complete queue until an active snapshot finishes, then retires absent rows", async () => {
    const old = forwardedInput("Consumed outside history");
    const retained = forwardedInput("Still waiting");
    const newest = forwardedInput("New request");
    const response = createDeferred<unknown>();
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: { "chat.history": () => response.promise },
    });
    applyChatPendingInputs(host, {
      items: [],
      total: 21,
      nextBefore: 21,
      queue: { items: [old, retained] },
    });
    applyChatPendingInputs(host, {
      items: [],
      total: 22,
      nextBefore: 22,
      queue: { items: [newest], nextBefore: 2 },
    });
    expect(queuedTexts(host)).toEqual([old.id, retained.id, newest.id]);
    response.resolve({
      sessionId,
      pendingInputs: { items: [], total: 22, nextBefore: 22, queue: { items: [retained] } },
    });
    await vi.waitFor(() =>
      expect(queuedTexts(host).toSorted()).toEqual([retained.id, newest.id].toSorted()),
    );
    expect(readChatInputRunIds(host)).not.toContain(old.runId);
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });

  it.each([false, true])(
    "refreshes every live queued input across receipt batches without reordering the shelf (same timestamp=%s)",
    async (sameTimestamp) => {
      const inputs = Array.from({ length: 51 }, (_, index) => ({
        ...input,
        id: `queued-${index}`,
        runId: `queued-${index}`,
        acceptedAt: sameTimestamp ? 100 : index,
        state: "queued" as const,
        queued: true as const,
        message: { role: "user", content: `Queued message ${index}` },
      }));
      let retireLast = false;
      const oldestPage = createDeferred();
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
          "chat.history": async (params: {
            pendingQueueBefore?: number;
            inputRunIds?: string[];
          }) => {
            const remaining = (retireLast ? inputs.slice(0, 50) : inputs).filter(
              (_, index) => index + 1 < (params.pendingQueueBefore ?? Infinity),
            );
            if (!retireLast && remaining.length === 11) {
              await oldestPage.promise;
            }
            return {
              sessionId,
              messages: [],
              pendingInputs: {
                items: [],
                total: 71,
                nextBefore: 21,
                queue: {
                  items: remaining.slice(-20),
                  ...(remaining.length > 20 ? { nextBefore: remaining.length - 19 } : {}),
                },
                queuedCount: retireLast ? 50 : 51,
              },
              inputReceipts: params.inputRunIds?.map((runId) =>
                runId === "browser-input"
                  ? { runId, state: "consumed", consumedByEventId: "browser-result" }
                  : {
                      runId,
                      state: "pending",
                      ...(retireLast && runId === "queued-50" ? {} : { queued: true }),
                    },
              ),
            };
          },
        },
      });
      applyChatPendingInputs(host, { items: [], total: 0 });
      const loading = loadChatPendingInputs(host);
      await vi.waitFor(() => expect(host.request).toHaveBeenCalledTimes(3));
      try {
        expect(queuedTexts(host)).toEqual(inputs.slice(11).map((item) => item.message.content));
      } finally {
        oldestPage.resolve();
        await loading;
      }
      expect(queuedTexts(host)).toEqual(inputs.map((item) => item.message.content));
      expect(host.chatQueue).toEqual([]);

      retireLast = true;
      host.request.mockClear();
      await loadChatPendingInputs(host);
      expect(queuedTexts(host)).toEqual(inputs.slice(0, 50).map((item) => item.message.content));
      const batches = host.request.mock.calls.map(
        ([, params]) => (params as { inputRunIds?: string[] }).inputRunIds ?? [],
      );
      expect(batches.every((batch) => batch.length <= 50)).toBe(true);
      expect(new Set(batches.flat())).toEqual(new Set(inputs.map((item) => item.runId)));
    },
  );

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
      latestPage.queue = { items: latestPage.items };
      refreshedLatestPage.queue = { items: refreshedLatestPage.items };
      olderPage.queue = latestPage.queue;
      refreshedOlderPage.queue = refreshedLatestPage.queue;
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
          "chat.history": (params: { pendingBefore?: number }) => {
            return params.pendingBefore === 21
              ? ++olderReads === 1
                ? navigation.promise
                : { sessionId, pendingInputs: refreshedOlderPage }
              : refreshFinished
                ? { sessionId, pendingInputs: refreshedLatestPage }
                : refresh.promise;
          },
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
      const olderPage: ChatPendingInputsPage = { items: [input], total: 2, queue: { items: [] } };
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
    const olderPage: ChatPendingInputsPage = { items: [input], total: 2, queue: { items: [] } };
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

function forwardedInput(
  id: string,
  runId: string | undefined = id,
): ChatPendingInputsPage["items"][number] {
  return {
    id,
    runId,
    acceptedAt: 100,
    state: "queued",
    message: {
      role: "assistant",
      content: id,
      timestamp: 100,
      provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      senderSession: { sessionKey: "agent:main:helper", agentId: "main" },
      __openclaw: { id: "pending:" + id },
    },
  };
}

function queuedTexts(host: Parameters<typeof getChatPendingInputs>[0]) {
  return Array.from(
    renderChatView({ historyState: host, sessionKey }).querySelectorAll(
      "[data-chat-queue-item] .chat-queue__text",
    ),
    (row) => row.textContent,
  );
}

it.each(["consumed", "cancelled", "absent", "interrupted", "readonly"] as const)(
  "reconciles %s input immediately even if a later active page fails",
  async (settled) => {
    const old = { ...forwardedInput("Settled input"), queued: true as const };
    const waiting = forwardedInput("Still waiting");
    const newest = forwardedInput("New input");
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: {
        "chat.history": () => Promise.reject(new Error("Active queue page unavailable")),
      },
    });
    applyChatPendingInputs(host, {
      items: [],
      total: 40,
      nextBefore: 21,
      queue: { items: [old, waiting] },
    });
    applyChatPendingInputs(
      host,
      {
        items: settled === "interrupted" ? [{ ...old, state: "interrupted" }] : [],
        total: 40,
        nextBefore: 21,
        queue: { items: [newest], nextBefore: 2 },
      },
      {
        queriedRunIds: [old.runId!],
        receipts:
          settled === "consumed"
            ? [{ runId: old.runId!, state: "consumed", consumedByEventId: "done" }]
            : settled === "cancelled"
              ? [{ runId: old.runId!, state: "pending", cancelled: true }]
              : settled === "absent"
                ? []
                : settled === "readonly"
                  ? [{ runId: old.runId!, state: "pending" }]
                  : undefined,
      },
    );
    await vi.waitFor(() =>
      expect(getChatPendingInputs(host)?.error).toContain("Active queue page unavailable"),
    );
    expect(queuedTexts(host).toSorted()).toEqual(
      [waiting.id, newest.id, ...(settled === "readonly" ? [old.id] : [])].toSorted(),
    );
    if (settled === "readonly") {
      expect(
        getChatPendingInputs(host)?.activeInputs.find((item) => item.id === old.id)?.queued,
      ).toBeUndefined();
    }
    expect(host.request).toHaveBeenCalledTimes(1);
  },
);

it("does not scan a retained terminal backlog to display the active queue", async () => {
  const forwarded = forwardedInput("Old but still waiting");
  const host = makeChatHost({
    sessionKey,
    currentSessionId: sessionId,
    requestHandlers: {
      "chat.history": (params: { pendingBefore?: number }) => {
        const end = params.pendingBefore ?? 4001;
        const start = Math.max(1, end - 20);
        return {
          sessionId,
          pendingInputs: {
            items: Array.from({ length: end - start }, (_, offset) => ({
              ...input,
              id: `retained-${start + offset}`,
              state: "cancelled",
            })),
            total: 4000,
            ...(start > 1 ? { nextBefore: start } : {}),
            queue: { items: [forwarded] },
          },
        };
      },
    },
  });
  applyChatPendingInputs(host, { items: [], total: 0 });
  await loadChatPendingInputs(host);
  expect(host.request).toHaveBeenCalledTimes(1);
  expect(queuedTexts(host)).toEqual([forwarded.id]);
  host.request.mockClear();
  await loadChatPendingInputs(host);
  expect(host.request).toHaveBeenCalledTimes(1);
  expect(queuedTexts(host)).toEqual([forwarded.id]);
});

it.each([true, false])(
  "retains a forwarded queue across Earlier and retires a full-snapshot absence (correlated=%s)",
  async (correlated) => {
    const forwarded = forwardedInput("Waiting agent update", correlated ? "agent-run" : undefined);
    if (!correlated) {
      delete forwarded.runId;
    }
    let consumed = false;
    const olderPage: ChatPendingInputsPage = {
      items: [input],
      total: 21,
      queuedCount: 0,
      queue: { items: [forwarded] },
    };
    const latestPage: ChatPendingInputsPage = {
      items: [forwarded],
      total: 21,
      nextBefore: 21,
      queuedCount: 0,
      queue: { items: [forwarded] },
    };
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: {
        "chat.history": (params: { pendingBefore?: number; inputRunIds?: string[] }) => ({
          sessionId,
          messages: [],
          pendingInputs: consumed
            ? { items: [input], total: 20, queuedCount: 0 }
            : params.pendingBefore === 21
              ? olderPage
              : latestPage,
          inputReceipts: params.inputRunIds?.flatMap((runId) =>
            !consumed && runId === forwarded.runId ? [{ runId, state: "pending" }] : [],
          ),
        }),
      },
    });
    applyChatPendingInputs(host, { items: [], total: 0, queuedCount: 0 });
    await loadChatPendingInputs(host);
    expect(queuedTexts(host)).toEqual([forwarded.id]);
    await loadChatPendingInputs(host, 21);
    expect(getChatPendingInputs(host)?.page).toEqual(olderPage);
    expect(getChatPendingInputs(host)?.before).toBe(21);
    expect(queuedTexts(host)).toEqual([forwarded.id]);
    expect(getChatPendingInputs(host)?.page.queuedCount).toBe(0);
    consumed = true;
    await loadChatPendingInputs(host);
    expect(queuedTexts(host)).toEqual([]);
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  },
);

it("discovers a forwarded input beyond the latest twenty without borrowing the execution queue count", async () => {
  const forwarded = forwardedInput("Older agent update");
  const human = {
    ...input,
    id: "human",
    runId: "human-run",
    state: "queued" as const,
    queued: true as const,
    message: { role: "user", content: "Human follow-up" },
  };
  const latestPage: ChatPendingInputsPage = {
    items: [human],
    total: 21,
    nextBefore: 21,
    queuedCount: 1,
    queue: { items: [forwarded, human] },
  };
  let cancelled = false;
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
                items: [cancelled ? { ...forwarded, state: "cancelled" } : forwarded],
                total: 21,
                queuedCount: 1,
                queue: { items: cancelled ? [human] : [forwarded, human] },
              }
            : latestPage,
        inputReceipts: params.inputRunIds?.map((runId) =>
          runId === human.runId
            ? { runId, state: "pending", queued: true }
            : { runId, state: "pending", ...(cancelled ? { cancelled: true } : {}) },
        ),
      }),
    },
  });
  applyChatPendingInputs(host, { items: [], total: 0, queuedCount: 0 });
  await loadChatPendingInputs(host);
  expect(getChatPendingInputs(host)?.page).toEqual(latestPage);
  expect(queuedTexts(host).toSorted()).toEqual([forwarded.id, "Human follow-up"].toSorted());
  expect(getChatPendingInputs(host)?.page.queuedCount).toBe(1);
  expect(readChatInputRunIds(host)).toContain(forwarded.runId);
  expect(host.request).toHaveBeenCalledTimes(1);
  cancelled = true;
  await loadChatPendingInputs(host, 21);
  expect(queuedTexts(host)).toEqual(["Human follow-up"]);
});

it("retires interrupted input from an active snapshot even when its receipt still says pending", async () => {
  const forwarded = forwardedInput("Interrupted agent update");
  const host = makeChatHost({ sessionKey, currentSessionId: sessionId, requestHandlers: {} });
  applyChatPendingInputs(host, {
    items: [input],
    total: 21,
    nextBefore: 21,
    queue: { items: [forwarded] },
  });
  expect(queuedTexts(host)).toEqual([forwarded.id]);
  applyChatPendingInputs(
    host,
    { items: [input], total: 21, nextBefore: 21, queue: { items: [] } },
    { receipts: [{ runId: forwarded.runId!, state: "pending" }] },
  );
  expect(queuedTexts(host)).toEqual([]);
  expect(host.request).not.toHaveBeenCalled();
});

it("restarts active discovery after a newer snapshot without publishing the stale response", async () => {
  const stale = createDeferred<unknown>();
  const newest = forwardedInput("Newest agent update");
  const older = forwardedInput("Older agent update");
  const host = makeChatHost({
    sessionKey,
    currentSessionId: sessionId,
    requestHandlers: {
      "chat.history": (params: { pendingQueueBefore?: number }) =>
        params.pendingQueueBefore === 21
          ? stale.promise
          : {
              sessionId,
              pendingInputs: { items: [], total: 200, nextBefore: 180, queue: { items: [older] } },
            },
    },
  });
  applyChatPendingInputs(host, {
    items: [],
    total: 200,
    nextBefore: 180,
    queue: { items: [], nextBefore: 21 },
  });
  applyChatPendingInputs(host, {
    items: [],
    total: 201,
    nextBefore: 181,
    queue: { items: [newest], nextBefore: 22 },
  });
  stale.resolve({
    sessionId,
    pendingInputs: { items: [], total: 200, queue: { items: [forwardedInput("Stale")] } },
  });
  await vi.waitFor(() =>
    expect(queuedTexts(host).toSorted()).toEqual([older.id, newest.id].toSorted()),
  );
  expect(getChatPendingInputs(host)?.before).toBeUndefined();
  expect(
    host.request.mock.calls.map(
      ([, params]) => (params as { pendingQueueBefore?: number }).pendingQueueBefore,
    ),
  ).toEqual([21, 22]);
});

it.each([true, false])(
  "refreshes the browsed page when a newer snapshot interrupts discovery (partial=%s)",
  async (partial) => {
    const stale = createDeferred<unknown>();
    const newest = forwardedInput("Newer queued update");
    const recovered = { ...input, state: "queued", queued: true as const };
    let reads = 0;
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: {
        "chat.history": async (params: { pendingQueueBefore?: number }) => {
          reads++;
          if (reads === 2) {
            return stale.promise;
          }
          return {
            sessionId,
            pendingInputs:
              reads === 1
                ? { items: [input], total: 21, queue: { items: [], nextBefore: 2 } }
                : {
                    items: [recovered],
                    total: 21,
                    queue: {
                      items:
                        params.pendingQueueBefore === undefined ? [recovered, newest] : [recovered],
                    },
                  },
          };
        },
      },
    });
    applyChatPendingInputs(host, { items: [], total: 21, nextBefore: 21, queue: { items: [] } });
    const navigation = loadChatPendingInputs(host, 21);
    await vi.waitFor(() => expect(reads).toBe(2));
    applyChatPendingInputs(host, {
      items: [],
      total: 21,
      queue: {
        items: partial ? [newest] : [recovered, newest],
        ...(partial ? { nextBefore: 3 } : {}),
      },
    });
    stale.resolve({
      sessionId,
      pendingInputs: { items: [input], total: 21, queue: { items: [] } },
    });
    await navigation;
    expect(reads).toBe(3);
    expect(getChatPendingInputs(host)?.before).toBe(21);
    expect(getChatPendingInputs(host)?.page.items).toEqual([recovered]);
    expect(queuedTexts(host)).toEqual(["Keep my accepted input", newest.id]);
    const rendered = renderChatView({ historyState: host, sessionKey });
    expect(rendered.querySelectorAll("[data-chat-queue-item]")).toHaveLength(2);
    expect(rendered.querySelectorAll(".chat-group")).toHaveLength(0);
  },
);

it("prefers active custody over an interrupted retained copy of the same input", () => {
  const host = makeChatHost({ sessionKey, currentSessionId: sessionId, requestHandlers: {} });
  const recovered = { ...input, state: "queued", queued: true as const };
  applyChatPendingInputs(host, { items: [input], total: 21, queue: { items: [recovered] } });
  const rendered = renderChatView({ historyState: host, sessionKey });
  expect(rendered.querySelectorAll("[data-chat-queue-item]")).toHaveLength(1);
  expect(rendered.querySelectorAll(".chat-group")).toHaveLength(0);
});

it.each(["retained", "queue-only"])(
  "keeps a %s human pending input visible when its later receipt withdraws queue authority",
  (location) => {
    const host = makeChatHost({ sessionKey, currentSessionId: sessionId, requestHandlers: {} });
    const queued = { ...input, state: "queued", queued: true as const };
    applyChatPendingInputs(
      host,
      location === "retained"
        ? { items: [queued], total: 1 }
        : { items: [], total: 21, nextBefore: 21, queue: { items: [queued] } },
      {
        receipts: [{ runId: input.runId!, state: "pending" }],
        queriedRunIds: [input.runId!],
      },
    );
    const rendered = renderChatView({ historyState: host, sessionKey });
    expect(rendered.querySelectorAll("[data-chat-queue-item]")).toHaveLength(0);
    expect(rendered.querySelectorAll(".chat-group.user")).toHaveLength(1);
    expect(rendered.querySelector(".chat-group.user")?.textContent).toContain(
      "Keep my accepted input",
    );
  },
);

it("discovers old Gateway queue-less pages without losing newer inputs during Earlier navigation", async () => {
  const older = forwardedInput("Older legacy input");
  const newer = { ...forwardedInput("Newer legacy input"), acceptedAt: 200 };
  const latest = { items: [newer], total: 2, nextBefore: 2 };
  const earliest = { items: [older], total: 2 };
  const host = makeChatHost({
    sessionKey,
    currentSessionId: sessionId,
    requestHandlers: {
      "chat.history": (params: { pendingBefore?: number; pendingQueueBefore?: number }) => {
        expect(params).not.toHaveProperty("pendingQueueBefore");
        return { sessionId, pendingInputs: params.pendingBefore === 2 ? earliest : latest };
      },
    },
  });
  applyChatPendingInputs(host, latest);
  await vi.waitFor(() => expect(queuedTexts(host)).toEqual([older.id, newer.id]));
  await loadChatPendingInputs(host, 2);
  expect(getChatPendingInputs(host)?.before).toBe(2);
  expect(getChatPendingInputs(host)?.page).toEqual(earliest);
  expect(queuedTexts(host)).toEqual([older.id, newer.id]);
});

it("stops a non-advancing active cursor without clearing the previous queue", async () => {
  const forwarded = forwardedInput("Waiting agent update");
  const host = makeChatHost({
    sessionKey,
    currentSessionId: sessionId,
    requestHandlers: {
      "chat.history": {
        sessionId,
        pendingInputs: { items: [], total: 200, queue: { items: [], nextBefore: 21 } },
      },
    },
  });
  applyChatPendingInputs(host, {
    items: [],
    total: 200,
    nextBefore: 180,
    queue: { items: [forwarded], nextBefore: 21 },
  });
  await vi.waitFor(() =>
    expect(getChatPendingInputs(host)?.error).toContain("Could not finish loading queued messages"),
  );
  expect(queuedTexts(host)).toEqual([forwarded.id]);
  expect(host.request).toHaveBeenCalledTimes(1);
});
