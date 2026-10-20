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
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import type { readSessionMessageByIdAsync } from "./session-transcript-readers.js";

export function registerCommittedTranscriptPublicationTests(
  fixture: Pick<ReturnType<typeof createSubscriptionTestFixture>, "createParams" | "warn"> & {
    start: typeof startGatewayEventSubscriptions;
    transcriptBroadcastMocks: {
      useActualHandler: boolean;
      readMessageById: Mock<typeof readSessionMessageByIdAsync>;
    };
  },
) {
  const { createParams, start, transcriptBroadcastMocks, warn } = fixture;
  it.for([1, 3])(
    "retains %s committing roots through transcript publication and shutdown",
    async (count, { signal }) => {
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
      const projection = createSessionRowProjectionFixture({
        cfg: { agents: { entries: { main: {} } } },
        storePath: "/tmp/openclaw-committed-transcript.sqlite",
        store: {
          "agent:main:main": {
            sessionId: "committed-session",
            lifecycleRevision: "original",
            updatedAt: 1,
          },
        },
      });
      const unsubs = start({ ...params, getSessionRowProjection: () => projection });
      const admissions = Array.from({ length: count }, () =>
        tryBeginGatewayRootWorkAdmission("test:committed-transcript-publisher"),
      );
      if (admissions.some((admission) => !admission)) {
        throw new Error("Transcript publisher admission was closed");
      }
      let shutdown: Promise<void> | undefined;
      try {
        const emitCommitted = (index: number) =>
          admissions[index]!.run(async () =>
            producer.run(() =>
              emitSessionTranscriptUpdate({
                messageId: "committed-message-" + index,
                lifecycleRevision: "original",
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
        await emitCommitted(0);
        await withinTest(readEntered.promise, signal);
        for (let index = 1; index < count; index++) {
          await emitCommitted(index);
        }
        for (const admission of admissions) {
          admission!.release();
        }
        await producer.drain();
        expect(getActiveGatewayRootWorkCount()).toBe(count);
        shutdown = unsubs.agentUnsub();
        const publicationBeforeShutdown = awaitGateBeforeSettlement(
          published.promise,
          shutdown,
          "Gateway shutdown finished before the committed transcript was published",
        );
        releaseRead.resolve();
        await withinTest(publicationBeforeShutdown, signal);
        await shutdown;
        expect(params.broadcastToConnIds).toHaveBeenNthCalledWith(
          1,
          "session.message",
          expect.objectContaining({
            sessionKey: "agent:main:main",
            messageId: "committed-message-0",
            message: expect.objectContaining({ content: storedMessage.content }),
          }),
          new Set(["conn-transcript"]),
          expect.objectContaining({ sessionEventSubscriptionKeys: ["agent:main:main"] }),
        );
        expect(transcriptBroadcastMocks.readMessageById).toHaveBeenCalledOnce();
        expect(params.broadcastToConnIds).toHaveBeenCalledTimes(count === 1 ? 1 : 2);
        if (count > 1) {
          expect(params.broadcastToConnIds).toHaveBeenNthCalledWith(
            2,
            "sessions.changed",
            expect.objectContaining({ sessionKey: "agent:main:main", phase: "message" }),
            new Set(["conn-transcript"]),
            expect.objectContaining({ sessionEventSubscriptionKeys: ["agent:main:main"] }),
          );
        }
        expect(warn).not.toHaveBeenCalled();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        releaseRead.resolve();
        for (const admission of admissions) {
          admission?.release();
        }
        await producer.drain();
        await shutdown;
        projection.dispose();
      }
    },
  );
}
