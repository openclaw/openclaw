import { expect, it, vi, type Mock } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import type { createSubscriptionTestFixture } from "./server-runtime-subscriptions.test-support.js";
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
  warn: ReturnType<typeof createSubscriptionTestFixture>["warn"];
}): void {
  const { createParams, start, transcriptBroadcastMocks, warn } = fixture;
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
