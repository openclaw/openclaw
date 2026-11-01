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
  const { createParams, start, transcriptBroadcastMocks: mocks, warn } = fixture;
  const target = {
    agentId: "main",
    sessionId: "committed-session",
    sessionKey: "agent:main:main",
    storePath: "/tmp/openclaw-committed-transcript.sqlite",
  };
  it.for([1, 3])(
    "retains %s roots until shutdown publishes committed transcripts",
    async (count, { signal }) => {
      mocks.useActualHandler = true;
      const readEntered = createDeferred();
      const releaseRead = createDeferred();
      const published = createDeferred();
      const producer = new AsyncWorkScope();
      const storedMessage = {
        role: "assistant",
        content: [{ type: "text", text: "committed completion" }],
        __openclaw: { transcriptPosition: { source: "committed-generation", rawSeq: 1 } },
      };
      mocks.readMessageById.mockImplementationOnce(async () => {
        const readSignal = getAsyncWorkSignal();
        readEntered.resolve();
        await releaseRead.promise;
        readSignal?.throwIfAborted();
        return { found: true, oversized: false, seq: 1, message: storedMessage };
      });
      const params = createParams();
      params.sessionEventSubscribers.subscribe("conn-transcript");
      const broadcastToConnIds = vi.fn(() => published.resolve());
      params.broadcastToConnIds = broadcastToConnIds;
      const projection = createSessionRowProjectionFixture({
        cfg: { agents: { entries: { main: {} } } },
        storePath: target.storePath,
        store: {
          [target.sessionKey]: {
            sessionId: target.sessionId,
            lifecycleRevision: "original",
            updatedAt: 1,
          },
        },
      });
      const unsubs = start({ ...params, getSessionRowProjection: () => projection });
      const admissions = Array.from({ length: count }, () => {
        const admission = tryBeginGatewayRootWorkAdmission("test:committed-transcript-publisher");
        if (!admission) {
          throw new Error("Transcript publisher admission was closed");
        }
        return admission;
      });
      const releaseAdmissions = () => admissions.forEach((admission) => admission.release());
      let shutdown: Promise<void> | undefined;
      try {
        const emitCommitted = (index: number) =>
          admissions[index]!.run(async () =>
            producer.run(() =>
              emitSessionTranscriptUpdate({
                messageId: "committed-message-" + index,
                lifecycleRevision: "original",
                message: storedMessage,
                target,
              }),
            ),
          );
        await emitCommitted(0);
        await withinTest(readEntered.promise, signal);
        for (let index = 1; index < count; index++) {
          await emitCommitted(index);
        }
        releaseAdmissions();
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
        const publication = (event: string, payload: object) => [
          event,
          expect.objectContaining({ sessionKey: target.sessionKey, ...payload }),
          new Set(["conn-transcript"]),
          expect.objectContaining({ sessionEventSubscriptionKeys: [target.sessionKey] }),
        ];
        expect(broadcastToConnIds.mock.calls).toEqual([
          publication("session.message", {
            messageId: "committed-message-0",
            message: expect.objectContaining({ content: storedMessage.content }),
          }),
          ...(count > 1 ? [publication("sessions.changed", { phase: "message" })] : []),
        ]);
        expect(mocks.readMessageById).toHaveBeenCalledOnce();
        expect(warn).not.toHaveBeenCalled();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        releaseRead.resolve();
        releaseAdmissions();
        await producer.drain();
        await shutdown;
        projection.dispose();
      }
    },
  );
}
