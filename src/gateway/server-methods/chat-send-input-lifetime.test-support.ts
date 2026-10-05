import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { markRestartAbortedMainSessions } from "../../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  appendTranscriptMessageSync,
  listSessionPendingInputs,
  loadSessionEntry,
  publishTranscriptUpdate,
  readSessionSubmittedInput,
} from "../../config/sessions/session-accessor.js";
import * as pendingInputOwner from "../../config/sessions/session-accessor.pending-inputs.js";
import {
  prepareGatewaySuspend,
  getGatewaySuspendStatus,
  resumeGatewaySuspend,
} from "../../infra/gateway-suspend-coordinator.js";
import { tryBeginGatewayRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import {
  captureGatewayRestartRecoveryRuns,
  prepareGatewayRunShutdown,
} from "../server-run-shutdown.js";
import { dispatchInboundMessageMock } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

export function registerLateAckRecoveryCases(
  createBrowserFollowupFixture: ReturnType<typeof useBrowserFollowupFixture>,
) {
  it.each(
    ["before", "after"].flatMap((registration) =>
      ["complete", "restart"].map((disposition) => ({ registration, disposition })),
    ),
  )(
    "retains a real late-ACK root whose registration arrives $registration the drain snapshot ($disposition)",
    async ({ registration, disposition }) => {
      const fixture = await createBrowserFollowupFixture({ preserveContent: true });
      const resolver = () => fixture.context;
      fixture.context.resolveGatewayContext = resolver;
      const root = tryBeginGatewayRootWorkAdmission("chat.send late-ACK capture proof");
      if (!root) {
        throw new Error("Expected original request root admission");
      }
      const reachedWriter = createDeferred();
      const releaseWriter = createDeferred();
      const stage = pendingInputOwner.stageSessionPendingInput;
      const writer = vi
        .spyOn(pendingInputOwner, "stageSessionPendingInput")
        .mockImplementation(async (...args) => {
          reachedWriter.resolve();
          await releaseWriter.promise;
          return stage(...args);
        });
      let sending: ReturnType<typeof fixture.send> | undefined;
      let suspensionId: string | undefined;
      try {
        if (registration === "before") {
          sending = root.run(() => fixture.send());
          await reachedWriter.promise;
        }
        const capture = vi.fn(async (assertCurrent: () => void) => {
          const snapshot = captureGatewayRestartRecoveryRuns({
            ...fixture.context,
            acceptedOnly: true,
          });
          expect(
            snapshot.activeRuns.some((run) => run.runId === fixture.params.idempotencyKey),
          ).toBe(registration === "before");
          await markRestartAbortedMainSessions({
            resolveGatewayContext: resolver,
            cfg: fixture.context.getRuntimeConfig(),
            ...snapshot,
            captureGoals: true,
            assertCommitAllowed: assertCurrent,
          });
        });
        const prepared = await prepareGatewaySuspend({
          requestId: "late-ACK-native-capture",
          drain: true,
          pauseScheduling: () => {},
          resumeScheduling: () => {},
          inspect: {
            getChatRuns: () => fixture.context.chatAbortControllers.size,
            getQueuedTurns: () => fixture.context.chatQueuedTurns.size,
            getTerminalPersistence: () => 0,
          },
          beforeDrain: capture,
        });
        if (prepared.status !== "draining") {
          throw new Error("Original root must keep the suspension draining");
        }
        suspensionId = prepared.suspensionId;
        if (!sending) {
          sending = root.run(() => fixture.send());
        }
        releaseWriter.resolve();
        const ack = await sending;
        expect(ack).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "started" }),
          undefined,
          expect.anything(),
        );
        expect(
          fixture.context.chatAbortControllers.get(fixture.params.idempotencyKey)?.accepted,
        ).toBe(true);
        const accepted = (await listSessionPendingInputs(fixture.scope)).items[0];
        expect(accepted).toMatchObject({ runId: fixture.params.idempotencyKey, state: "queued" });
        expect(getGatewaySuspendStatus(suspensionId).status).toBe("draining");
        if (disposition === "restart") {
          await root.run(() =>
            prepareGatewayRunShutdown({
              ...fixture.context,
              resolveGatewayContext: resolver,
              restart: true,
              timeoutMs: 0,
              warnings: [],
              getPendingReplyCount: () => 0,
              markMainSessionsAbortedForRestart: async (params) => {
                await markRestartAbortedMainSessions({
                  ...params,
                  cfg: fixture.context.getRuntimeConfig(),
                });
              },
            }),
          );
        }
        await fixture.finishDispatch();
        root.release();
        expect(getGatewaySuspendStatus(suspensionId).status).toBe("ready");
        expect(capture).toHaveBeenCalledOnce();
        const pending = (await listSessionPendingInputs(fixture.scope)).items[0];
        if (pending) {
          expect(pending).toEqual({ ...accepted, state: "interrupted" });
        } else {
          expect(
            await readSessionSubmittedInput(fixture.scope, `${fixture.params.idempotencyKey}:user`),
          ).toEqual(accepted?.message);
        }
        if (disposition === "restart") {
          expect(loadSessionEntry(fixture.scope)?.abortedLastRun).toBe(true);
          expect(loadSessionEntry(fixture.scope)?.restartRecoveryRuns).toContainEqual(
            expect.objectContaining({ runId: fixture.params.idempotencyKey }),
          );
        } else {
          expect(pending).toBeUndefined();
          expect(loadSessionEntry(fixture.scope)?.mainRestartRecovery).toBeUndefined();
        }
      } finally {
        releaseWriter.resolve();
        await sending;
        await fixture.cleanup();
        root.release();
        if (suspensionId) {
          resumeGatewaySuspend(suspensionId);
        }
        writer.mockRestore();
      }
    },
  );
}

export function registerChatHistoryDeliveryCases(
  createBrowserFollowupFixture: ReturnType<typeof useBrowserFollowupFixture>,
) {
  it.each(["webchat", "queued-webchat", "external"] as const)(
    "keeps committed history delivery with the %s source owner",
    async (route) => {
      const fixture = await createBrowserFollowupFixture({ active: false });
      const entered = createDeferred<Parameters<typeof dispatchInboundMessage>[0]>();
      const release = createDeferred();
      let settleQueued: (() => void) | undefined;
      if (route === "external") {
        fixture.params.originatingChannel = "discord";
        fixture.params.originatingTo = "channel:synthetic";
        fixture.params.deliver = true;
      }
      dispatchInboundMessageMock.mockImplementation(async (dispatchParams: unknown) => {
        const options = dispatchParams as Parameters<typeof dispatchInboundMessage>[0];
        if (route === "queued-webchat") {
          // The queue retains cancellation/admission after the initial dispatch unwinds.
          options.replyOptions?.turnAdoptionLifecycle?.onDeferred?.();
          settleQueued = options.replyOptions?.turnAdoptionLifecycle?.onSettled;
        }
        entered.resolve(options);
        if (route !== "queued-webchat") {
          await release.promise;
        }
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      });
      try {
        const ack = await fixture.send();
        expect(ack.mock.calls[0]?.[0]).toBe(true);
        const { replyOptions } = await entered.promise;
        if (route === "queued-webchat") {
          await vi.waitFor(() =>
            expect(fixture.context.chatAbortControllers.has(fixture.params.idempotencyKey)).toBe(
              false,
            ),
          );
        }
        await replyOptions?.userTurnTranscriptRecorder?.persistApproved();
        await replyOptions?.onAgentRunStart?.(fixture.params.idempotencyKey);
        const message = attachSessionTranscriptRunId(
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "The synthetic fixture is ready.",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "receipt-answer",
                  phase: "final_answer",
                }),
              },
              { type: "toolCall", id: "inspect", name: "read", arguments: {} },
            ],
            stopReason: "toolUse",
          },
          fixture.params.idempotencyKey,
        );
        const appended = appendTranscriptMessageSync(fixture.scope, {
          eventId: "route-answer",
          message,
        });
        if (!appended?.ok) {
          throw new Error("Expected committed route fixture answer");
        }
        await publishTranscriptUpdate(fixture.scope, { message, messageId: "route-answer" });
        expect((await replyOptions?.resolveReplyDelivery?.()) ?? "missing").toBe(
          route === "external" ? "missing" : "delivered",
        );
        if (route === "queued-webchat") {
          settleQueued?.();
          expect(await replyOptions?.resolveReplyDelivery?.()).toBe("missing");
        }
      } finally {
        settleQueued?.();
        release.resolve();
        await fixture.cleanup();
      }
    },
  );
}
