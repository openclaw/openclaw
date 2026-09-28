/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { discardChatRecoveryInput } from "./chat-input-recovery-actions.ts";
import { createChatInputRecoveryQueueProps } from "./chat-input-recovery-view.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
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
  getChatRecoveryInputs,
  getChatThreadPendingInputs,
  loadChatPendingInputs,
  readChatInputRunIds,
} from "./chat-pending-inputs.ts";
import { admitQueuedMessageForSession } from "./chat-queue.ts";
import { flushChatQueueForEvent } from "./chat-send-actions.ts";
import { retireDeliveredQueuedUserTurn } from "./chat-send-support.ts";
import { ChatStateController } from "./chat-state-controller.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { renderChatView } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";
import * as scroll from "./scroll.ts";
import { cacheChatSessionSnapshot, type ChatMessageCache } from "./session-message-cache.ts";

beforeEach(() => {
  installTranscriptDomMocks();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => {
  resetTranscriptTestDom();
});

describe("server-owned pending input pagination", () => {
  it.each(["interrupted", "cancelled"] as const)(
    "keeps a restored held owner actionable beside %s custody",
    async (state) => {
      const host = makeChatPageHost({
        sessionKey,
        currentSessionId: sessionId,
        selfUser: { id: "viewer", name: "Viewer" },
        requestHandlers: {},
      });
      const unsubscribe = chatOutboxOwner(host).subscribe(host);
      try {
        const custody = { ...input, state };
        const saved = { ...input, id: "unrelated-saved", runId: "unrelated-run" };
        applyChatPendingInputs(host, { items: [custody, saved], total: 2, queuedCount: 0 });
        // Browser recovery can publish its retained owner after the server page arrives.
        for (const item of [
          {
            id: "held-owner",
            text: "Held delivery",
            createdAt: 1,
            sendRunId: input.runId,
            sendState: "held" as const,
            sendAttempts: 1,
          },
          {
            id: "successor",
            text: "Blocked successor",
            createdAt: 2,
            sendRunId: "successor-run",
            sendState: "waiting-idle" as const,
          },
        ]) {
          expect(
            admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
              ...item,
              sessionKey,
              sessionId,
            }),
          ).toBe(true);
        }
        const before = structuredClone(listStoredChatOutboxes(host));
        const paint = () =>
          renderChatView({
            historyState: host,
            sessionKey,
            messages: host.chatMessages,
            queue: host.chatQueue,
            recoveryQueue: createChatInputRecoveryQueueProps(host, true),
            onQueueRetry: (id) => {
              void host.retryQueuedChatMessage(id);
            },
            onQueueRemove: host.removeQueuedMessage,
          });
        let container = paint();
        expect(
          container.querySelectorAll('.chat-send-status[data-send-state="held"]'),
        ).toHaveLength(1);
        expect(container.querySelector(".chat-send-status__retry")).not.toBeNull();
        expect(container.querySelectorAll("[data-chat-queue-item=successor]")).toHaveLength(1);
        expect(container.querySelectorAll("[data-chat-recovery-input]")).toHaveLength(1);
        expect(getChatRecoveryInputs(host)).toEqual([saved]);

        // A saved-attempt dismissal cannot conceal the only action for a FIFO blocker.
        discardChatRecoveryInput(host, input.id);
        expect(listStoredChatOutboxes(host)).toEqual(before);
        container
          .querySelector<HTMLButtonElement>("[data-chat-recovery-input] .chat-queue__remove")
          ?.click();
        await flushChatQueueForEvent(host);
        container = paint();
        expect(container.querySelector("[data-chat-recovery-input]")).toBeNull();
        expect(container.querySelector(".chat-send-status__retry")).not.toBeNull();
        expect(listStoredChatOutboxes(host)).toEqual(before);
        expect(
          host.request.mock.calls.filter(
            ([method]) => method === "chat.send" || method === "chat.abort",
          ),
        ).toEqual([]);

        // Only the local owner's explicit native action removes its delivery barrier.
        host.connected = false;
        const discard = expectDefined(
          container.querySelector<HTMLButtonElement>(".chat-send-status__discard"),
          "local discard action",
        );
        discard.click();
        expect(host.chatQueue.map((item) => item.id)).toEqual(["successor"]);
        expect(
          listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue.map((item) => item.id)),
        ).toEqual(["successor"]);
      } finally {
        unsubscribe();
      }
    },
  );

  it("does not schedule scrolling or unread intent for recovery-only publications", () => {
    const schedule = vi.spyOn(scroll, "scheduleCommittedChatScroll");
    const controller = new ChatStateController<ChatPageHost>({
      addController: () => {},
      removeController: () => {},
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    });
    const host = makeChatPageHost({
      sessionKey,
      currentSessionId: sessionId,
      chatHasAutoScrolled: true,
      chatUserNearBottom: true,
      requestHandlers: {},
    });
    controller.hostConnected();
    host.renderLifecycle = controller.createRenderLifecycle();
    controller.attach(host);
    try {
      const empty = getChatThreadPendingInputs(host);
      for (const state of ["interrupted", "cancelled"] as const) {
        applyChatPendingInputs(host, { items: [{ ...input, state }], total: 1 });
        controller.hostUpdated();
        expect(getChatThreadPendingInputs(host)).toBe(empty);
        expect(host.chatFollowLocked).toBe(false);
        expect(host.chatUserNearBottom).toBe(true);
      }
      expect(schedule).not.toHaveBeenCalled();
      applyChatPendingInputs(host, {
        items: [{ ...input, state: "queued", queued: true }],
        total: 1,
        queuedCount: 1,
      });
      expect(host.chatFollowLocked).toBe(true);
      expect(host.chatUserNearBottom).toBe(false);
    } finally {
      controller.hostDisconnected();
      schedule.mockRestore();
    }
  });

  it.each(["waiting", "running"] as const)(
    "browses saved records without replacing %s custody or its scroll identity",
    async (state) => {
      const waiting = state === "waiting";
      const older = { ...input, id: "older", runId: "older-run" };
      const accepted = {
        ...input,
        id: "accepted",
        state: "queued" as const,
        queued: waiting ? (true as const) : undefined,
        message: { role: "user", content: "Current accepted input" },
      };
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        requestHandlers: {
          "chat.history": () => ({
            sessionId,
            pendingInputs: { items: [older], total: 2, queuedCount: waiting ? 1 : 0 },
          }),
        },
      });
      applyChatPendingInputs(host, {
        items: [accepted],
        total: 2,
        nextBefore: 2,
        queuedCount: waiting ? 1 : 0,
      });
      const active = getChatThreadPendingInputs(host);
      expect(active).toEqual([accepted]);
      await loadChatPendingInputs(host, 2);
      expect(getChatRecoveryInputs(host)).toEqual([older]);
      expect(getChatThreadPendingInputs(host)).toBe(active);
      const container = renderChatView({ historyState: host, sessionKey });
      expect(container.textContent).toContain("Current accepted input");
      expect(container.querySelectorAll(".chat-queue__item")).toHaveLength(waiting ? 1 : 0);
      const next = { ...accepted, id: "next", runId: "next-run" };
      applyChatPendingInputs(host, {
        items: [accepted, next],
        total: 3,
        nextBefore: 2,
        queuedCount: waiting ? 2 : 0,
      });
      expect(getChatThreadPendingInputs(host)).toEqual([accepted, next]);
      expect(getChatPendingInputs(host)?.page.items).toEqual([older]);
    },
  );

  it("rereads a superseded same-input page but still accepts a fresh cancellation", async () => {
    const stale = createDeferred<unknown>();
    const active = { ...input, state: "queued" as const };
    const cancelled = { ...input, state: "cancelled" as const };
    let reads = 0;
    let current: typeof active | typeof cancelled = active;
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: {
        "chat.history": () =>
          ++reads === 1
            ? stale.promise
            : {
                sessionId,
                pendingInputs: { items: [current], total: 2, queuedCount: 0 },
                inputReceipts: [{ runId: input.runId, state: "pending" }],
              },
      },
    });
    applyChatPendingInputs(host, { items: [input], total: 2, nextBefore: 2, queuedCount: 0 });
    const navigation = loadChatPendingInputs(host, 2);
    applyChatPendingInputs(host, { items: [active], total: 2, queuedCount: 0 });
    stale.resolve({ sessionId, pendingInputs: { items: [input], total: 2, queuedCount: 0 } });
    await navigation;
    expect(reads).toBe(2);
    expect(getChatThreadPendingInputs(host)).toEqual([active]);
    expect(getChatRecoveryInputs(host)).toEqual([]);

    current = cancelled;
    await loadChatPendingInputs(host, 2);
    expect(getChatThreadPendingInputs(host)).toEqual([]);
    expect(getChatRecoveryInputs(host)).toEqual([cancelled]);
  });

  it("binds recovery actions to the confirmed page rather than a reconnect read attempt", async () => {
    const response = createDeferred<{ sessionId: string; pendingInputs: ChatPendingInputsPage }>();
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: { "chat.history": () => response.promise },
    });
    applyChatPendingInputs(host, page);
    const view = expectDefined(getChatPendingInputs(host), "published pending page");
    const publishedEpoch = view.connectionEpoch;
    host.connectionEpoch += 1;
    const loading = loadChatPendingInputs(host, 2);
    expect(view.client).toBe(host.client);
    expect(view.connectionEpoch).toBe(publishedEpoch);
    expect(view.page).toBe(page);
    const older = { ...input, id: "older", runId: "older-run" };
    response.resolve({ sessionId, pendingInputs: { items: [older], total: 2 } });
    await loading;
    expect(view.connectionEpoch).toBe(host.connectionEpoch);
    expect(view.page.items).toEqual([older]);
  });

  it.each(["empty-queue", "complete-page", "partial-page-receipts"] as const)(
    "retires consumed server queue chips outside the transcript window using %s",
    async (source) => {
      const queuedInput = (id: string, acceptedAt: number) => ({
        ...input,
        id,
        runId: id,
        acceptedAt,
        state: "queued" as const,
        queued: true as const,
        message: { role: "user", content: id },
      });
      const consumed = queuedInput("Already handled while disconnected", 1);
      const retained = queuedInput("Still waiting on the server", 2);
      const replacement = queuedInput("New request from another participant", 3);
      let pendingInputs: ChatPendingInputsPage = {
        items: [consumed, retained],
        total: 2,
        queuedCount: 2,
      };
      let inputReceipts: ChatInputReceipts | undefined = undefined;
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        requestHandlers: {
          "chat.history": () => ({
            sessionId,
            // Consumption happened outside this retained transcript window.
            messages: [{ role: "assistant", content: "Recent activity only" }],
            pendingInputs,
            ...(inputReceipts ? { inputReceipts } : {}),
          }),
        },
      });
      const queueText = () =>
        Array.from(
          renderChatView({
            historyState: host,
            sessionKey,
            messages: host.chatMessages,
          }).querySelectorAll(".chat-queue__text"),
          (row) => row.textContent,
        );
      await loadChatHistory(host);
      expect(queueText()).toEqual([consumed.message.content, retained.message.content]);

      // A partial page alone cannot retire either previously observed input.
      pendingInputs = { items: [], total: 21, nextBefore: 21, queuedCount: 2 };
      await loadChatHistory(host);
      expect(queueText()).toEqual([consumed.message.content, retained.message.content]);

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

      expect(queueText()).toEqual(
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
