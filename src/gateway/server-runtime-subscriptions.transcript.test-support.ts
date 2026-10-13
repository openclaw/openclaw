import { expect, it, vi, type Mock } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { claimAgentRunContext, clearAgentRunContext } from "../infra/agent-run-registry.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import type { createSubscriptionTestFixture } from "./server-runtime-subscriptions.test-support.js";
import { registerSubscriptionChatRun } from "./server-runtime-subscriptions.test-support.js";
import type { readSessionMessageByIdAsync } from "./session-transcript-readers.js";

export function registerTranscriptPublicationTests(fixture: {
  createParams: ReturnType<typeof createSubscriptionTestFixture>["createParams"];
  start: (
    params: Parameters<typeof startGatewayEventSubscriptions>[0],
  ) => ReturnType<typeof startGatewayEventSubscriptions>;
  transcriptBroadcastMocks: {
    useActualHandler: boolean;
    readMessageById: Mock<typeof readSessionMessageByIdAsync>;
  };
  installHandlerFactory: (
    factory: typeof import("./server-chat.js").createAgentEventHandler,
  ) => void;
  warn: ReturnType<typeof createSubscriptionTestFixture>["warn"];
}): void {
  const { createParams, start, transcriptBroadcastMocks, warn } = fixture;
  it.for(["streaming", "paced", "terminal", "replacement", "disposed", "queued"] as const)(
    "keeps the assistant visible through delayed transcript publication (%s)",
    async (mode, { signal }) => {
      const actual = await vi.importActual<typeof import("./server-chat.js")>("./server-chat.js");
      if (mode === "paced") {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      }
      transcriptBroadcastMocks.useActualHandler = true;
      const params = createParams();
      const runId = "delayed-transcript-run";
      const sessionKey = "agent:main:main";
      const sessionId = "delayed-transcript-session";
      const registration = registerSubscriptionChatRun(params, { runId, sessionId, sessionKey });
      claimAgentRunContext(runId, { sessionId, sessionKey });
      const successorRunId = "queued-successor-run";
      if (mode === "queued") {
        params.chatRunState.registry.add(runId, { sessionKey, clientRunId: runId });
        params.chatRunState.registry.add(runId, { sessionKey, clientRunId: successorRunId });
      }
      const firstText = createDeferred();
      const readEntered = createDeferred();
      const releaseRead = createDeferred();
      const continued = createDeferred();
      const ended = createDeferred();
      const delivered: Array<{ event: string; payload: unknown }> = [];
      params.broadcast = (event, payload) => {
        if (event === "chat") {
          delivered.push({ event, payload });
          firstText.resolve();
        }
      };
      params.broadcastToConnIds = (event, payload) => {
        if (event === "session.message") {
          delivered.push({ event, payload });
        }
      };
      params.sessionEventSubscribers.subscribe("conn-transcript");
      let disposeHandler: (() => Promise<void>) | undefined;
      fixture.installHandlerFactory((options) => {
        const handler = actual.createAgentEventHandler(options);
        disposeHandler = handler.dispose;
        return Object.assign(async (event: Parameters<typeof handler>[0]) => {
          await handler(event);
          if (event.data.itemId === "continued-item") {
            continued.resolve();
          }
          if (event.stream === "lifecycle" && event.data.phase === "end") {
            ended.resolve();
          }
        }, handler);
      });
      const storedMessage = {
        role: "assistant",
        idempotencyKey: "committed-item",
        content: [{ type: "text", text: "Visible before persistence." }],
        __openclaw: { runId },
      };
      transcriptBroadcastMocks.readMessageById.mockImplementationOnce(async () => {
        readEntered.resolve();
        await releaseRead.promise;
        return { found: true, oversized: false, seq: 1, message: storedMessage };
      });
      const unsubs = start(params);
      let shutdown: Promise<void> | undefined;
      let handlerShutdown: Promise<void> | undefined;
      try {
        emitAgentEvent({
          runId,
          stream: "assistant",
          data: { itemId: "committed-item", text: "Visible before persistence." },
        });
        await withinTest(firstText.promise, signal);
        emitSessionTranscriptUpdate({
          sessionKey,
          messageId: "committed-message",
          message: storedMessage,
          target: {
            agentId: "main",
            sessionId,
            sessionKey,
            storePath: "/tmp/openclaw-delayed-transcript.sqlite",
          },
        });
        await withinTest(readEntered.promise, signal);
        expect(delivered).toHaveLength(1);
        if (mode === "replacement") {
          clearAgentRunContext(runId);
          params.chatRunState.clearRun(runId);
          claimAgentRunContext(runId, { sessionId: "replacement-session", sessionKey });
        }
        if (mode === "disposed") {
          handlerShutdown = disposeHandler?.();
        }
        const emitContinuation = () =>
          emitAgentEvent({
            runId,
            stream: "assistant",
            data: {
              itemId: "continued-item",
              text: "Unpersisted continuation.",
              ...(mode === "paced" ? {} : { replace: true }),
            },
          });
        if (mode !== "queued") {
          emitContinuation();
          await withinTest(continued.promise, signal);
          expect(params.chatRunState.resolveBuffer(runId).text).toBe(
            mode === "disposed" ? "" : "Unpersisted continuation.",
          );
        }
        const terminal = mode === "terminal" || mode === "replacement" || mode === "queued";
        if (terminal) {
          emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
          await withinTest(ended.promise, signal);
        }
        if (mode === "queued") {
          // The real finalizer shifts the finishing registration before its
          // terminal is sent. The successor must still stream independently.
          claimAgentRunContext(runId, { sessionId, sessionKey });
          emitContinuation();
          await withinTest(continued.promise, signal);
          expect(delivered.at(-1)?.payload).toMatchObject({
            runId: successorRunId,
            state: "delta",
          });
        }
        expect(delivered).toHaveLength(mode === "replacement" ? 3 : mode === "queued" ? 2 : 1);
        shutdown = unsubs.agentUnsub();
        releaseRead.resolve();
        await withinTest(shutdown, signal);
        await handlerShutdown;
        expect(delivered.map(({ event }) => event)).toEqual(
          mode === "replacement"
            ? ["chat", "chat", "chat", "session.message"]
            : mode === "queued"
              ? ["chat", "chat", "session.message", "chat"]
              : ["chat", "session.message", "chat"],
        );
        expect(delivered.findLast(({ event }) => event === "chat")?.payload).toMatchObject({
          runId,
          state: terminal ? "final" : "delta",
          ...(mode === "queued"
            ? { message: { openclawDisplayContent: [] } }
            : mode === "terminal"
              ? {
                  message: {
                    openclawDisplayContent: [{ type: "text", text: "Unpersisted continuation." }],
                  },
                }
              : {
                  message: {
                    content: [
                      {
                        type: "text",
                        text: mode === "disposed" ? "" : "Unpersisted continuation.",
                      },
                    ],
                  },
                }),
        });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        releaseRead.resolve();
        await (shutdown ?? unsubs.agentUnsub());
        await handlerShutdown;
        params.chatRunState.clear();
        registration.cleanup();
      }
    },
  );
  it("publishes committed transcripts after the producer drains and before Gateway shutdown", async ({
    signal,
  }) => {
    transcriptBroadcastMocks.useActualHandler = true;
    const readEntered = createDeferred();
    const releaseRead = createDeferred();
    const published = createDeferred();
    const producer = new AsyncWorkScope();
    const storedMessage = {
      role: "assistant",
      content: [{ type: "text", text: "committed completion" }],
      __openclaw: { transcriptPosition: { source: "committed-generation", rawSeq: 1 } },
    };
    transcriptBroadcastMocks.readMessageById.mockImplementationOnce(async () => {
      const readSignal = getAsyncWorkSignal();
      readEntered.resolve();
      await releaseRead.promise;
      readSignal?.throwIfAborted();
      return { found: true, oversized: false, seq: 1, message: storedMessage };
    });
    const params = createParams();
    params.sessionEventSubscribers.subscribe("conn-transcript");
    params.broadcastToConnIds = vi.fn(() => published.resolve());
    const unsubs = start(params);
    const admission = tryBeginGatewayRootWorkAdmission("test:committed-transcript-publisher");
    if (!admission) {
      throw new Error("Transcript publisher admission was closed");
    }
    let shutdown: Promise<void> | undefined;
    try {
      await admission.run(async () =>
        producer.run(() =>
          emitSessionTranscriptUpdate({
            messageId: "committed-message",
            message: storedMessage,
            target: {
              agentId: "main",
              sessionId: "committed-session",
              sessionKey: "agent:main:main",
              storePath: "/tmp/openclaw-committed-transcript.sqlite",
            },
          }),
        ),
      );
      await withinTest(readEntered.promise, signal);
      admission.release();
      await producer.drain();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      shutdown = unsubs.agentUnsub();
      const publicationBeforeShutdown = awaitGateBeforeSettlement(
        published.promise,
        shutdown,
        "Gateway shutdown finished before the committed transcript was published",
      );
      releaseRead.resolve();
      await withinTest(publicationBeforeShutdown, signal);
      await shutdown;
      expect(params.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        "session.message",
        expect.objectContaining({
          sessionKey: "agent:main:main",
          messageId: "committed-message",
          message: expect.objectContaining({ content: storedMessage.content }),
        }),
        new Set(["conn-transcript"]),
        undefined,
      );
      expect(warn).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      releaseRead.resolve();
      admission.release();
      await producer.drain();
      await shutdown;
    }
  });

  it("logs real asynchronous transcript failures and recovers the broadcast queue", async ({
    signal,
  }) => {
    transcriptBroadcastMocks.useActualHandler = true;
    const readEntered = createDeferred();
    const failedRead = createDeferred();
    const failureReported = createDeferred();
    const recoveredPublication = createDeferred();
    const persistenceFailure = new Error("session transcript read failed");
    const transcriptPosition = { source: "recovered-generation", rawSeq: 7 };
    const storedMessage = {
      role: "assistant",
      content: [{ type: "text", text: "visible answer" }],
      __openclaw: { transcriptPosition },
    };
    transcriptBroadcastMocks.readMessageById
      .mockImplementationOnce(async () => {
        readEntered.resolve();
        await failedRead.promise;
        throw persistenceFailure;
      })
      .mockResolvedValueOnce({ found: true, oversized: false, seq: 2, message: storedMessage });

    const params = createParams();
    params.sessionEventSubscribers.subscribe("conn-transcript");
    params.broadcastToConnIds = vi.fn(() => recoveredPublication.resolve());
    warn.mockImplementationOnce(() => failureReported.resolve());
    const unsubs = start(params);

    const emitMessage = (messageId: string) =>
      emitSessionTranscriptUpdate({
        sessionFile: "/tmp/openclaw-transcript-dispatch.sqlite",
        sessionKey: "agent:main:main",
        message: { role: "assistant", content: [{ type: "text", text: "stale queued answer" }] },
        messageId,
        target: {
          agentId: "main",
          sessionId: "sess-transcript",
          sessionKey: "agent:main:main",
          storePath: "/tmp/openclaw-transcript-dispatch-sessions.json",
        },
      });

    const admission = tryBeginGatewayRootWorkAdmission("test:transcript-publisher");
    if (!admission) {
      throw new Error("Transcript publisher admission was closed");
    }
    let shutdown: Promise<void> | undefined;
    try {
      await admission.run(async () => emitMessage("failed-message"));
      admission.release();
      await withinTest(readEntered.promise, signal);
      expect(transcriptBroadcastMocks.readMessageById).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      failedRead.resolve();
      await withinTest(failureReported.promise, signal);
      expect(warn).toHaveBeenCalledWith("Transcript update dispatch failed", {
        sessionKey: "agent:main:main",
        error: persistenceFailure,
      });
      expect(params.broadcastToConnIds).not.toHaveBeenCalled();

      emitMessage("recovered-message");
      await withinTest(recoveredPublication.promise, signal);
      expect(params.broadcastToConnIds).toHaveBeenCalledOnce();
      expect(params.broadcastToConnIds).toHaveBeenCalledWith(
        "session.message",
        expect.objectContaining({
          sessionKey: "agent:main:main",
          messageId: "recovered-message",
          messageSeq: 2,
          message: expect.objectContaining({
            content: storedMessage.content,
            __openclaw: expect.objectContaining({ transcriptPosition }),
          }),
        }),
        new Set(["conn-transcript"]),
        undefined,
      );
      expect(transcriptBroadcastMocks.readMessageById).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledOnce();
      shutdown = unsubs.agentUnsub();
      await shutdown;
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      failedRead.resolve();
      admission.release();
      await (shutdown ?? unsubs.agentUnsub());
    }
  });
}
