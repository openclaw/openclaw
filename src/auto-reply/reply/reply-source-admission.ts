import { randomUUID } from "node:crypto";
import { bindUserTurnInputActor } from "../../config/sessions/session-input-actor.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { assertSessionControllerOperation } from "../../sessions/session-controller.identity.js";
import type { SessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import {
  acquireReplyOperationSessionActor,
  getReplyOperationSessionTarget,
} from "../../sessions/session-controller.session-reader.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { completeFollowupRunLifecycle } from "./queue/lifecycle.js";
import type { FollowupRun } from "./queue/types.js";

/** Acquire original input custody before maintenance or a provider can consume it. */
export async function prepareReplySourceAdmission(params: {
  operation: ReplyOperation;
  followupRun: FollowupRun;
  recorder?: UserTurnTranscriptRecorder;
  runId?: string;
}): Promise<(() => Promise<void>) | undefined> {
  const { operation, followupRun, recorder } = params;
  if (!recorder) {
    return undefined;
  }
  // Session events re-admit stale policy before their owner claims the durable source.
  // Early staging would bind that stable source to an attempt that never ran.
  if (followupRun.run.internalEventExecution) {
    return undefined;
  }
  const assertCurrent = () => {
    operation.abortSignal.throwIfAborted();
    if (operation.lifecycleGeneration) {
      assertAgentRunLifecycleGenerationCurrent(operation.lifecycleGeneration);
    }
    followupRun.operatorAuthority?.assertCurrent();
    assertSessionControllerOperation(operation);
  };
  assertCurrent();
  await recorder.resolveMessage();
  assertCurrent();
  const ownsCustody = !recorder.getPendingInputMessage?.() && !recorder.hasPersisted();
  const release = ownsCustody
    ? async () => {
        try {
          recorder.finishPendingInput?.("cancelled");
        } finally {
          await recorder.waitForPendingInputSettlement?.();
        }
      }
    : undefined;
  try {
    if (ownsCustody && getReplyOperationSessionTarget(operation)) {
      // First-turn staging precedes dispatch; use this operation's initialized
      // physical actor instead of the recorder's pre-initialization Gateway locator.
      bindUserTurnInputActor(recorder, {
        phase: "acceptInput",
        acquire: async () => {
          assertCurrent();
          const actor = await acquireReplyOperationSessionActor(operation);
          assertCurrent();
          const target = getReplyOperationSessionTarget(operation);
          if (!actor || !target) {
            throw new Error("Reply operation lost its session actor admission");
          }
          return { actor, target };
        },
      });
    }
    await recorder.stageApproved?.({ runId: params.runId ?? randomUUID(), assertCurrent });
    assertCurrent();
    return release;
  } catch (error) {
    await release?.();
    throw error;
  }
}

/** Acquire caller-owned custody before publishing a queued execution. */
export async function enqueueReplySourceAdmission(params: {
  options?: Pick<InternalGetReplyOptions, "turnAdoptionLifecycle" | "userTurnTranscriptRecorder">;
  input: SessionControllerInput;
  followupRun: FollowupRun;
  runId: string;
  assertCurrent: () => void;
  enqueue: () => boolean;
}): Promise<boolean> {
  const { options, input, runId } = params;
  const recorder =
    options?.turnAdoptionLifecycle?.admission === "cancel-only"
      ? options.userTurnTranscriptRecorder
      : undefined;
  const assertCurrent = () => {
    input.abortSignal.throwIfAborted();
    params.assertCurrent();
    input.sourceAdapter?.authority?.assertCurrent();
  };
  let staged = false;
  if (recorder && !recorder.getPendingInputMessage?.() && !recorder.hasPersisted()) {
    // Gateway recorders own cleanup, but slash commands skip initial staging.
    // Execution policy still resolves when the queued turn is admitted.
    const accepted = await recorder.stageApproved?.({ runId, assertCurrent });
    assertCurrent();
    if (recorder.isPendingInputConsumed?.()) {
      completeFollowupRunLifecycle(params.followupRun, "consumed");
      return false;
    }
    if (accepted === false) {
      throw new Error("Followup input could not acquire durable custody");
    }
    staged = accepted === true;
  }
  const enqueued = params.enqueue();
  if (!enqueued && staged) {
    recorder?.finishPendingInput?.("cancelled");
    await recorder?.waitForPendingInputSettlement?.();
  }
  return enqueued;
}
