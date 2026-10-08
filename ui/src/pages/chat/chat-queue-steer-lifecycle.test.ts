// @vitest-environment jsdom
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { extractText } from "../../lib/chat/message-extract.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { chatItemGroups } from "./chat-agent-run-grouping.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { buildPendingInputQueueItems, getChatPendingInputs } from "./chat-pending-inputs.ts";
import { admitQueuedMessageForSession } from "./chat-queue.ts";
import { retryQueuedChatMessage, steerQueuedChatMessage } from "./chat-send-actions.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { readPendingSendStatus } from "./chat-thread-items.ts";
import { renderChatQueue } from "./components/chat-composer-queue.ts";
import { renderChatSendStatus } from "./components/chat-message-send-status.ts";
import { projectTranscriptChain } from "./components/chat-transcript-message-index.ts";
import { selectChatInputDisplay } from "./history-merge.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { applyChatCacheSnapshot, readChatSessionSnapshot } from "./session-message-cache.ts";

useChatSendBrowserFixture();
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

it.each(["custody", "receipt", "retry", "remount"] as const)(
  "keeps a queued steer once at the live edge through %s and history",
  async (ackMode) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const sessionKey = "agent:main:queue-steer";
    const original = {
      role: "user",
      content: "Original prompt",
      timestamp: 1,
      __openclaw: { id: "original", seq: 1, idempotencyKey: "active-run:user" },
    };
    const queued = {
      id: "queued-steer",
      text: "Take over the other work too",
      createdAt: 2_000,
      sendRunId: "steer-send",
      sendState: "waiting-idle" as const,
      sessionKey,
      agentId: "main",
    };
    const history: ChatHistoryResult = {
      messages: [original],
      sessionId: "queue-steer-session",
      sessionInfo: {
        key: sessionKey,
        sessionId: "queue-steer-session",
        kind: "direct",
        hasActiveRun: true,
        activeRunIds: ["active-run"],
        status: "running",
      },
      inFlightRun: { runId: "active-run", text: "Already visible output.", startedAt: 5_000 },
    };
    const requested = createDeferred();
    const ack = createDeferred<unknown>();
    const retryRequested = createDeferred();
    const retryAck = createDeferred<unknown>();
    let requests = 0;
    let host = makeChatHost({
      sessionKey,
      chatMessagesBySession: new Map(),
      requestHandlers: {
        "chat.history": history,
        "chat.send": () => {
          if (++requests > 1) {
            retryRequested.resolve();
            return retryAck.promise;
          }
          requested.resolve();
          return ack.promise;
        },
      },
    });
    // Queue actions return after admission. Observe the pane's transport owner
    // releasing the request so ACK assertions cannot race its async continuation.
    let transport = createDeferred();
    let chatSending = host.chatSending;
    Object.defineProperty(host, "chatSending", {
      get: () => chatSending,
      set: (value: boolean) => {
        const wasSending = chatSending;
        chatSending = value;
        if (wasSending && !value) {
          transport.resolve();
        }
      },
    });
    vi.spyOn(host.sessions, "reconcileMutation").mockResolvedValue({ status: "refreshed" });
    vi.spyOn(host.sessions, "listBranches").mockResolvedValue([]);
    await loadChatHistory(host);
    expect(
      admitQueuedMessageForSession(
        host,
        captureChatOutboxAdmission(host, sessionKey, "main"),
        queued,
      ),
    ).toBe(true);
    const container = document.createElement("div");
    const recovery = document.createElement("div");
    document.body.append(container, recovery);
    let sending: Promise<void> | undefined;
    const snapshot = () => {
      const pending = getChatPendingInputs(host);
      const inputs = pending
        ? [...pending.page.items.filter((input) => !input.queued), ...pending.queuedInputs]
        : [];
      const display = selectChatInputDisplay(host.chatMessages, host.chatQueue, inputs);
      let sendStatus: ReturnType<typeof readPendingSendStatus> = null;
      const messageText = (message: unknown) => {
        const status = readPendingSendStatus(message);
        if (status?.id === queued.id) {
          sendStatus = status;
        }
        return extractText(message);
      };
      render(
        renderChatQueue({
          canAbort: true,
          queue: host.chatQueue,
          displayQueue: [...buildPendingInputQueueItems(display.queuedInputs), ...display.queue],
          onQueueSteer: (id) => {
            sending = steerQueuedChatMessage(host, id);
          },
          onQueueRemove: vi.fn(),
        }),
        container,
      );
      const thread = projectTranscriptChain(
        buildChatItems({
          paneId: "queue-steer-lifecycle",
          sessionKey,
          runId: host.chatRunId,
          messages: host.chatMessages,
          queue: host.chatQueue,
          pendingInputs: inputs,
          toolMessages: host.chatToolMessages ?? [],
          streamSegments: host.chatStreamSegments ?? [],
          stream: host.chatStream,
          streamStartedAt: host.chatStreamStartedAt,
          showToolCalls: true,
        }),
        { sessionKey, runWorking: true, searchActive: false },
      ).transcriptItems.flatMap((item) =>
        item.kind === "stream-run"
          ? item.parts.flatMap((part) => (part.kind === "stream" ? [part.text] : []))
          : item.kind === "agent-run-frame"
            ? item.parts.flatMap((part) =>
                part.kind === "stream-run"
                  ? part.parts.flatMap((stream) => (stream.kind === "stream" ? [stream.text] : []))
                  : chatItemGroups(part).flatMap((group) =>
                      group.messages.map(({ message }) => messageText(message)),
                    ),
              )
            : chatItemGroups(item).flatMap((group) =>
                group.messages.map(({ message }) => messageText(message)),
              ),
      );
      render(
        renderChatSendStatus(sendStatus, {
          onRetryQueuedMessage: (id) => {
            sending = retryQueuedChatMessage(host, id);
          },
        }),
        recovery,
      );
      return {
        thread,
        queue: [...container.querySelectorAll(".chat-queue__item")].map((item) =>
          item.textContent?.includes(queued.text) ? queued.text : "other queued input",
        ),
      };
    };
    try {
      expect(snapshot()).toEqual({
        thread: [original.content, "Already visible output."],
        queue: [queued.text],
      });
      container.querySelector<HTMLButtonElement>(".chat-queue__steer")!.click();
      await requested.promise;
      const delivered = [original.content, "Already visible output.", queued.text];
      expect.soft(snapshot(), "request dispatch").toEqual({ thread: delivered, queue: [] });
      let continued = false;
      let prefixPersisted = false;
      const continueOutput = () => {
        continued = true;
        history.inFlightRun!.text = prefixPersisted
          ? "Later output."
          : "Already visible output. Later output.";
        handleChatGatewayEvent(host, {
          sessionKey,
          runId: "active-run",
          state: "delta",
          message: { role: "assistant", content: history.inFlightRun!.text },
        });
      };
      const expected = () => ({
        thread: [
          original.content,
          ...(prefixPersisted
            ? ["Already visible output.", ...(continued ? ["Later output."] : [])]
            : [continued ? "Already visible output. Later output." : "Already visible output."]),
          queued.text,
        ],
        queue: [],
      });
      if (ackMode === "retry") {
        ack.reject(new Error("Steer rejected"));
        await transport.promise;
        expect.soft(snapshot(), "rejected delivery").toEqual(expected());
        expect
          .soft(host.chatQueue, "rejected source")
          .toMatchObject([{ id: queued.id, sendState: "failed" }]);
        const retry = recovery.querySelector<HTMLButtonElement>(".chat-send-status__retry");
        expect(retry?.textContent?.trim()).toBe("Retry");
        continueOutput();
        expect.soft(snapshot(), "output after rejected delivery").toEqual(expected());
        transport = createDeferred();
        retry!.click();
        await retryRequested.promise;
        expect.soft(snapshot(), "retry retains original run ownership").toEqual(expected());
      }
      (ackMode === "retry" ? retryAck : ack).resolve({
        runId: queued.sendRunId,
        status: "started",
        ...(ackMode === "receipt" || ackMode === "remount" ? { messageSeq: 3 } : {}),
      });
      await transport.promise;
      expect(host.chatRunId).toBe("active-run");
      expect.soft(snapshot(), "ACK").toEqual(expected());
      if (ackMode === "custody" || ackMode === "retry") {
        history.pendingInputs = {
          items: [
            {
              id: "accepted-steer",
              runId: queued.sendRunId,
              message: { role: "user", content: queued.text, timestamp: 10_000 },
              acceptedAt: 10_000,
              state: "queued",
              queued: true,
            },
          ],
          total: 1,
          queuedCount: 1,
        };
      }
      await loadChatHistory(host);
      expect.soft(snapshot(), "history before persisted copy").toEqual(expected());
      if (ackMode === "remount") {
        // The producer has persisted the prefix; an older page still omits the
        // consumed steer when the pane is recreated from its actual cache.
        history.messages = [
          original,
          {
            role: "assistant",
            content: "Already visible output.",
            timestamp: 5_000,
            __openclaw: { id: "pre-steer", seq: 2, runId: "active-run" },
          },
        ];
        prefixPersisted = true;
        history.inFlightRun!.text = "";
        await loadChatHistory(host);
        const cached = readChatSessionSnapshot(host.chatMessagesBySession!, host, { sessionKey });
        expect(cached).not.toBeNull();
        const previous = host;
        host = makeChatHost({
          sessionKey,
          client: previous.client,
          chatSubmissions: previous.chatSubmissions,
          chatMessagesBySession: previous.chatMessagesBySession,
          requestHandlers: { "chat.history": history },
        });
        vi.spyOn(host.sessions, "reconcileMutation").mockResolvedValue({ status: "refreshed" });
        vi.spyOn(host.sessions, "listBranches").mockResolvedValue([]);
        previous.sessions.dispose();
        applyChatCacheSnapshot(host, cached!);
        await loadChatHistory(host);
        expect
          .soft(snapshot(), "new pane keeps explicit local steer ownership")
          .toEqual(expected());
      }
      history.pendingInputs = { items: [], total: 0, queuedCount: 0 };
      history.inputReceipts = [
        {
          runId: queued.sendRunId,
          state: "consumed",
          consumedByEventId: "persisted-steer",
        },
      ];
      await loadChatHistory(host);
      expect.soft(snapshot(), "consumption before the transcript page").toEqual(expected());
      if (!continued) {
        continueOutput();
      }
      expect.soft(snapshot(), "continued output").toEqual(expected());
      const steer = {
        role: "user",
        content: queued.text,
        timestamp: 10_000,
        __openclaw: {
          id: "persisted-steer",
          seq: 3,
          idempotencyKey: `${queued.sendRunId}:user`,
          steerTargetRunId: "active-run",
        },
      };
      applySessionMessagePayload(host, { message: steer }, true, {
        kind: "live",
        activeRunId: "active-run",
      });
      history.messages = [...history.messages!, steer];
      history.pendingInputs = { items: [], total: 0, queuedCount: 0 };
      history.inFlightRun!.text = prefixPersisted
        ? "Later output."
        : "Already visible output. Later output.";
      await loadChatHistory(host);
      expect.soft(snapshot(), "persisted copy replaces optimistic").toEqual(expected());
      history.messages = [
        original,
        {
          role: "assistant",
          content: "Already visible output.",
          timestamp: 5_000,
          __openclaw: { id: "pre-steer", seq: 2, runId: "active-run" },
        },
        steer,
        {
          role: "assistant",
          content: "Later output.",
          timestamp: 11_000,
          __openclaw: { id: "post-steer", seq: 4, runId: "active-run" },
        },
      ];
      history.inFlightRun = undefined;
      history.sessionInfo = {
        ...history.sessionInfo!,
        hasActiveRun: false,
        activeRunIds: [],
        status: "done",
        lastRunId: "active-run",
      };
      await loadChatHistory(host);
      expect.soft(snapshot(), "finished history").toEqual({
        thread: [original.content, "Already visible output.", "Later output.", queued.text],
        queue: [],
      });
    } finally {
      ack.resolve({ runId: queued.sendRunId, status: "started" });
      retryAck.resolve({ runId: queued.sendRunId, status: "started" });
      await sending;
      if (host.chatSending) {
        await transport.promise;
      }
      host.sessions.dispose();
    }
  },
);
