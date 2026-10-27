import { randomUUID } from "node:crypto";
import { bindUserTurnInputActor } from "../../config/sessions/session-input-actor.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { assertSessionControllerOperation } from "../../sessions/session-controller.identity.js";
import {
  acquireReplyOperationSessionActor,
  getReplyOperationSessionTarget,
} from "../../sessions/session-controller.session-reader.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
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
          recorder.finishPendingInput?.(
            operation.result?.kind === "aborted" && operation.result.code === "aborted_by_user"
              ? "cancelled"
              : "interrupted",
          );
        } finally {
          await recorder.waitForPendingInputSettlement?.();
        }
      }
    : undefined;
  try {
    if (ownsCustody && getReplyOperationSessionTarget(operation)) {
      // First-turn staging precedes recovery admission; use this operation's initialized
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
