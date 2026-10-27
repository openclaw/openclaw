// @vitest-environment jsdom
import { createComponent, createSignal, merge } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { extractText } from "../../lib/chat/message-extract.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { chatItemGroups } from "./chat-agent-run-grouping.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-outbox-admission.test-support.ts";
import { buildPendingInputQueueItems, getChatPendingInputs } from "./chat-pending-inputs.ts";
import { retryQueuedChatMessage, steerQueuedChatMessage } from "./chat-send-actions.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { nativeMessage } from "./chat-thread-fixtures.test-support.ts";
import { readPendingSendStatus } from "./chat-thread-items.ts";
import { renderChatQueueSolid } from "./components/chat-composer-queue.tsx";
import { ChatSendStatus } from "./components/chat-message-send-status-view.tsx";
import { projectTranscriptChain } from "./components/chat-transcript-message-index.ts";
import { selectChatInputDisplay } from "./history-merge.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { applyChatCacheSnapshot, readChatSessionSnapshot } from "./session-message-cache.ts";

useChatSendBrowserFixture();
afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.useRealTimers();
});

it.each(["custody", "receipt", "retry", "remount", "deferred", "deferred-remount"] as const)(
  "reconciles steering placement through %s and history",
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
    let historyFailure: Error | undefined;
    let host = makeChatHost({
      sessionKey,
      chatMessagesBySession: new Map(),
      requestHandlers: {
        "chat.history": () => {
          if (historyFailure) {
            const error = historyFailure;
            historyFailure = undefined;
            throw error;
          }
          return history;
        },
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
    const [queueProps, setQueueProps] = createSignal<Parameters<typeof renderChatQueueSolid>[0]>({
      queue: [],
      onQueueRemove: vi.fn(),
    });
    mountSolid(() => createComponent(renderChatQueueSolid, merge(queueProps)), { container });
    const [sendState, setSendState] = createSignal<ReturnType<typeof readPendingSendStatus>>(null);
    mountSolid(
      () =>
        createComponent(ChatSendStatus, {
          get status() {
            return sendState();
          },
          actions: {
            onRetryQueuedMessage: (id) => {
              sending = retryQueuedChatMessage(host, id);
            },
          },
        }),
      { container: recovery },
    );
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
      setQueueProps({
        runId: host.chatRunId,
        canAbort: true,
        queue: host.chatQueue,
        displayQueue: [...buildPendingInputQueueItems(display.queuedInputs), ...display.queue],
        onQueueSteer: (id) => {
          sending = steerQueuedChatMessage(host, id);
        },
        onQueueRemove: vi.fn(),
      });
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
      setSendState(sendStatus);
      flush();
      return {
        thread,
        queue: [...container.querySelectorAll(".chat-queue__item")].map((item) =>
          item.textContent?.includes(queued.text) ? queued.text : "other queued input",
        ),
      };
    };
    try {
      const waiting = {
        thread: [original.content, "Already visible output."],
        queue: [queued.text],
      };
      expect(snapshot()).toEqual(waiting);
      expect(container.querySelector(".chat-queue__remove")).not.toBeNull();
      container.querySelector<HTMLButtonElement>(".chat-queue__steer")!.click();
      await requested.promise;
      expect.soft(snapshot(), "request dispatch").toEqual(waiting);
      expect(container.querySelector(".chat-queue__remove")).toBeNull();
      let deferred = false;
      let consumed = false;
      let continued = false;
      let prefixPersisted = false;
      let steerProjected = true;
      let placed = ackMode === "receipt" || ackMode === "remount";
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
          ...(prefixPersisted ? ["Already visible output."] : []),
          ...(!deferred && steerProjected && placed ? [queued.text] : []),
          ...(prefixPersisted
            ? continued
              ? ["Later output."]
              : []
            : [continued ? "Already visible output. Later output." : "Already visible output."]),
          ...(!deferred && !steerProjected ? [queued.text] : []),
        ],
        queue: !consumed && (deferred || (!placed && steerProjected)) ? [queued.text] : [],
      });
      if (ackMode === "retry") {
        ack.reject(new Error("Steer rejected"));
        await transport.promise;
        steerProjected = false;
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
        steerProjected = true;
        expect
          .soft(snapshot(), "retry awaits acceptance without replacing the active run")
          .toEqual({
            thread: [original.content, "Already visible output. Later output."],
            queue: [queued.text],
          });
      }
      if (ackMode === "custody" || ackMode === "retry" || ackMode.startsWith("deferred")) {
        deferred = ackMode.startsWith("deferred");
        history.pendingInputs = {
          items: [
            {
              id: "accepted-steer",
              runId: queued.sendRunId,
              message: { role: "user", content: queued.text, timestamp: 10_000 },
              acceptedAt: 10_000,
              state: "queued",
            },
          ],
          total: 1,
          queuedCount: 0,
        };
      }
      if (ackMode === "deferred") {
        historyFailure = new Error("Custody refresh unavailable");
      }
      (ackMode === "retry" ? retryAck : ack).resolve({
        runId: queued.sendRunId,
        status: "started",
        ...(ackMode === "receipt" || ackMode === "remount" ? { messageSeq: 3 } : {}),
      });
      await transport.promise;
      expect(host.chatRunId).toBe("active-run");
      expect.soft(snapshot(), "ACK").toEqual(expected());
      expect(requests).toBe(ackMode === "retry" ? 2 : 1);
      if (deferred && history.pendingInputs) {
        history.pendingInputs = {
          ...history.pendingInputs,
          queuedCount: 1,
          items: history.pendingInputs.items.map((input) => ({ ...input, queued: true })),
        };
      }
      await loadChatHistory(host);
      expect.soft(snapshot(), "history before persisted copy").toEqual(expected());
      if (ackMode === "remount" || ackMode === "deferred-remount") {
        // The producer has persisted the prefix; an older page still omits the
        // submitted steer when the pane is recreated from its actual cache.
        history.messages = [
          original,
          nativeMessage("assistant", "Already visible output.", 5_000, {
            id: "pre-steer",
            seq: 2,
            runId: "active-run",
          }),
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
        expect.soft(snapshot(), "new pane keeps authoritative input placement").toEqual(expected());
      }
      consumed = true;
      placed = !deferred;
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
      deferred = false;
      placed = true;
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
        nativeMessage("assistant", "Already visible output.", 5_000, {
          id: "pre-steer",
          seq: 2,
          runId: "active-run",
        }),
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
        thread: [original.content, "Already visible output.", queued.text, "Later output."],
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
