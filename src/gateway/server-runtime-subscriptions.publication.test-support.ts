import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi, type Mock } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import {
  bindAgentAssistantSource,
  emitAgentEvent,
  emitAgentEventWithAssistantSourceIfCurrent,
  type AgentAssistantSourceReceipt,
  type AgentEventRuntimePayload,
} from "../infra/agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  getAgentRunContextOwnerStatus,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import type { createSubscriptionTestFixture } from "./server-runtime-subscriptions.test-support.js";
import { registerSubscriptionChatRun } from "./server-runtime-subscriptions.test-support.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import type { readSessionMessageByIdAsync } from "./session-transcript-readers.js";

export function registerSessionPublicationTests(fixture: {
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
  it("joins committed lifecycle publication before subscription shutdown", async ({ signal }) => {
    vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
    const key = "agent:main:finished-child";
    const entry = { sessionId: "finished-child", updatedAt: 1, lifecycleRevision: "original" };
    const projection = createSessionRowProjectionFixture({
      cfg: { agents: { entries: { main: {} } } },
      store: { [key]: entry },
    });
    const entered = createDeferred();
    const release = createDeferred();
    const published = createDeferred();
    const prepare = projection.withPreparedExactRows.bind(projection);
    const preparation = vi
      .spyOn(projection, "withPreparedExactRows")
      .mockImplementation(async (...args) => {
        entered.resolve();
        await release.promise;
        return prepare(...args);
      });
    const producer = new AsyncWorkScope();
    const params = createParams();
    params.sessionEventSubscribers.subscribe("conn-lifecycle");
    params.broadcastToConnIds = vi.fn(() => published.resolve());
    warn.mockImplementation((_message: string, context: { error: unknown }) =>
      published.reject(context.error),
    );
    // Observe failure even if it occurs before the held preparation is reached.
    void published.promise.catch(() => {});
    const unsubs = start({ ...params, getSessionRowProjection: () => projection });
    let shutdown: Promise<void> | undefined;
    try {
      producer.run(() => emitSessionLifecycleEvent({ sessionKey: key, reason: "subagent-status" }));
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          published.promise,
          "Lifecycle publication settled before row preparation",
        ),
        signal,
      );
      await producer.drain();
      let closed = false;
      shutdown = unsubs.agentUnsub().then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(closed).toBe(false);
      release.resolve();
      await withinTest(published.promise, signal);
      await (shutdown ?? unsubs.agentUnsub());
      expect(params.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        "sessions.changed",
        expect.objectContaining({
          sessionKey: key,
          reason: "subagent-status",
          session: expect.objectContaining({ key, sessionId: entry.sessionId }),
        }),
        new Set(["conn-lifecycle"]),
        expect.objectContaining({ dropIfSlow: true }),
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await producer.drain();
      await withinTest(published.promise, signal).catch(() => {});
      await (shutdown ?? unsubs.agentUnsub());
      preparation.mockRestore();
      warn.mockReset();
      projection.dispose();
      vi.useRealTimers();
    }
  });
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
  it.for([
    { terminal: false, mixed: false, claimedError: false, retry: false, failureKind: "exception" },
    { terminal: false, mixed: false, claimedError: false, retry: true, failureKind: "exception" },
    { terminal: true, mixed: false, claimedError: false, retry: false, failureKind: "exception" },
    { terminal: true, mixed: true, claimedError: false, retry: false, failureKind: "exception" },
    { terminal: true, mixed: false, claimedError: true, retry: false, failureKind: "exception" },
    { terminal: true, mixed: false, claimedError: false, retry: false, failureKind: "rebuilding" },
    { terminal: true, mixed: false, claimedError: false, retry: false, failureKind: "overloaded" },
  ])(
    "retains failed publication text without duplicating saved rows (terminal=$terminal, mixed=$mixed, claimedError=$claimedError, failure=$failureKind, retry=$retry)",
    async ({ terminal, mixed, claimedError, failureKind, retry }, { signal }) => {
      const actual = await vi.importActual<typeof import("./server-chat.js")>("./server-chat.js");
      transcriptBroadcastMocks.useActualHandler = true;
      const params = createParams();
      const runId = "failed-publication-run";
      const sessionKey = "agent:main:main";
      const sessionId = "failed-publication-session";
      const registration = registerSubscriptionChatRun(params, {
        runId,
        sessionId,
        sessionKey,
        ...(claimedError ? { kind: "agent" as const } : {}),
      });
      claimAgentRunContext(runId, { sessionId, sessionKey });
      const readEntered = createDeferred();
      const releaseRead = createDeferred();
      const failureReported = createDeferred();
      const savedPublished = createDeferred();
      let processed = createDeferred();
      let errorClaim: string | undefined;
      const delivered: Array<{ event: string; payload: unknown }> = [];
      params.broadcast = (event, payload) => {
        if (event === "chat") {
          delivered.push({ event, payload });
        }
      };
      params.broadcastToConnIds = (event, payload) => {
        if (event === "session.message") {
          delivered.push({ event, payload });
          savedPublished.resolve();
        } else if (event === "sessions.changed") {
          delivered.push({ event, payload });
          failureReported.resolve();
        }
      };
      params.sessionEventSubscribers.subscribe("conn-transcript");
      let directHandler: ReturnType<typeof actual.createAgentEventHandler> | undefined;
      fixture.installHandlerFactory((options) => {
        const handler = actual.createAgentEventHandler({
          ...options,
          ...(claimedError ? { persistGatewaySessionLifecycleEventForEvent: async () => {} } : {}),
        });
        directHandler = handler;
        return Object.assign(async (event: Parameters<typeof handler>[0]) => {
          await handler(event);
          processed.resolve();
        }, handler);
      });
      const emitText = async (
        itemId: string,
        text: string,
        source?: AgentAssistantSourceReceipt,
      ) => {
        processed = createDeferred();
        emitAgentEventWithAssistantSourceIfCurrent(
          { runId, stream: "assistant", data: { itemId, text, replace: true } },
          source,
        );
        await withinTest(processed.promise, signal);
      };
      const persist = (messageId: string, message: unknown) =>
        emitSessionTranscriptUpdate({
          sessionKey,
          messageId,
          message,
          target: {
            agentId: "main",
            sessionId,
            sessionKey,
            storePath: "/synthetic/session.sqlite",
          },
        });
      const failure =
        failureKind === "rebuilding"
          ? new SessionTranscriptProjectionUnavailableError(sessionId)
          : failureKind === "overloaded"
            ? new WorkerTaskError("transcript reader overloaded", "overloaded")
            : new Error("transcript read unavailable");
      if (failureKind === "exception") {
        warn.mockImplementationOnce(() => failureReported.resolve());
      }
      const savedMessage = {
        role: "assistant",
        idempotencyKey: "successful-item",
        content: [{ type: "text", text: "Already published." }],
        __openclaw: { runId },
      };
      if (mixed) {
        transcriptBroadcastMocks.readMessageById.mockResolvedValueOnce({
          found: true,
          oversized: false,
          seq: 1,
          message: savedMessage,
        });
      }
      transcriptBroadcastMocks.readMessageById.mockImplementationOnce(async () => {
        readEntered.resolve();
        await releaseRead.promise;
        throw failure;
      });
      const source: AgentAssistantSourceReceipt = { itemId: "failed-item" };
      const failedMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Keep this reply visible." }],
        __openclaw: { runId },
      };
      bindAgentAssistantSource(failedMessage, source);
      const unsubs = start(params);
      try {
        if (mixed) {
          await emitText("successful-item", "Already published.");
          persist("successful-message", savedMessage);
          await withinTest(savedPublished.promise, signal);
        }
        await emitText("failed-item", "Keep this reply visible.", source);
        source.committedMessageSeq = 2;
        persist("failed-message", failedMessage);
        await withinTest(readEntered.promise, signal);
        if (terminal) {
          processed = createDeferred();
          if (claimedError) {
            const claim = claimAgentRunContext(
              runId,
              { sessionId, sessionKey },
              {
                trackOwner: true,
                ownsContext: true,
              },
            );
            errorClaim = claim;
            if (!claim) {
              throw new Error("Expected a claimed error lifecycle");
            }
            const lifecycleGeneration = getAgentRunContext(runId)?.lifecycleGeneration;
            if (!directHandler || !lifecycleGeneration) {
              throw new Error("Expected the loaded chat handler and its run generation");
            }
            // Invoke the finalizer after its write is admitted; the subscription's
            // captured-write queue is not part of this publication-barrier ordering.
            const terminalEvent: AgentEventRuntimePayload = {
              runId,
              seq: 2,
              ts: Date.now(),
              stream: "lifecycle",
              contextClaimId: claim,
              lifecycleGeneration,
              data: {
                phase: "error",
                error: "Provider failed",
                fallbackExhaustedFailure: true,
                assistantTranscriptIdempotencyKey: "failed-message",
              },
            };
            await directHandler(terminalEvent);
            await vi.waitFor(() =>
              expect(getAgentRunContextOwnerStatus(runId, claim, lifecycleGeneration)).toBe(
                "clear-requested",
              ),
            );
          } else {
            emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
          }
          if (!claimedError) {
            await withinTest(processed.promise, signal);
          }
        }
        releaseRead.resolve();
        await withinTest(failureReported.promise, signal);
        if (!terminal) {
          await vi.waitFor(() =>
            expect(params.chatRunState.resolveBuffer(runId).text).toBe("Keep this reply visible."),
          );
          // A later callback carrying the same durable receipt must not hide the fallback again.
          await emitText("failed-item", "Keep this corrected reply visible.", source);
          if (retry) {
            transcriptBroadcastMocks.readMessageById.mockResolvedValueOnce({
              found: true,
              oversized: false,
              seq: 2,
              message: failedMessage,
            });
            persist("failed-message", failedMessage);
            await withinTest(savedPublished.promise, signal);
          }
        }
        await withinTest(unsubs.agentUnsub(), signal);
        if (failureKind === "exception") {
          expect(warn).toHaveBeenCalledWith("Transcript update dispatch failed", {
            sessionKey,
            error: failure,
          });
        } else {
          expect(warn).not.toHaveBeenCalled();
          expect(
            delivered.filter(
              ({ event, payload }) =>
                event === "sessions.changed" && asNullableRecord(payload)?.phase === "message",
            ),
          ).toHaveLength(1);
        }
        expect(delivered.filter(({ event }) => event === "session.message")).toHaveLength(
          mixed || retry ? 1 : 0,
        );
        const last = delivered.findLast(({ event }) => event === "chat")?.payload;
        expect(last).toMatchObject({
          runId,
          state: claimedError ? "error" : terminal ? "final" : "delta",
        });
        const message = asNullableRecord(asNullableRecord(last)?.message);
        expect(message?.openclawDisplayContent ?? message?.content).toEqual(
          retry
            ? [{ type: "text", text: "" }]
            : [
                {
                  type: "text",
                  text: terminal
                    ? "Keep this reply visible."
                    : "Keep this corrected reply visible.",
                },
              ],
        );
        if (terminal) {
          expect(message?.content).toEqual([
            {
              type: "text",
              text: (mixed ? "Already published.\n\n" : "") + "Keep this reply visible.",
            },
          ]);
        }
      } finally {
        releaseRead.resolve();
        releaseAgentRunContext(runId, errorClaim);
        await unsubs.agentUnsub();
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
