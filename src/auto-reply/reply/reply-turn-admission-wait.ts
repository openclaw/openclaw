import { racePromiseWithAbortSignal, raceWithTimeout } from "../../../packages/retry/src/index.js";
import type {
  SessionControllerEntry,
  SessionControllerInput,
} from "../../sessions/session-controller.contracts.js";
import { createSessionControllerPhaseLogger } from "../../sessions/session-controller.diagnostics.js";
import { lifecycle } from "../../sessions/session-controller.lifecycle-state.js";
import {
  waitForReplyRunFollowupAdmission,
  waitForReplyRunSuccessorAdmission,
} from "../../sessions/session-controller.wait.js";
import type { ReplyTurnAdmissionParams } from "./reply-turn-admission.types.js";

/** Observe the captured controller's custody; the admission owner decides wait policy. */
export function createReplyTurnAdmissionWaiter(
  controller: SessionControllerEntry,
  params: Pick<ReplyTurnAdmissionParams, "sessionKey" | "runId" | "upstreamAbortSignal">,
) {
  return {
    async barrier(
      wait: { sessionId: string } & (
        | { phase: "followup-barrier"; timeoutMs: number }
        | { phase: "successor-barrier"; timeoutMs: number | null | undefined }
      ),
    ) {
      const logBarrier = createSessionControllerPhaseLogger(wait.phase, {
        sessionKey: params.sessionKey,
        sessionId: wait.sessionId,
        sourceId: params.runId,
      });
      logBarrier("waiting");
      const options = { signal: params.upstreamAbortSignal };
      const settlement =
        wait.phase === "followup-barrier"
          ? await waitForReplyRunFollowupAdmission(controller.id, wait.timeoutMs, options)
          : await waitForReplyRunSuccessorAdmission(controller.id, wait.timeoutMs, options);
      logBarrier(
        settlement.settled ? "settled" : "failed",
        settlement.settled ? undefined : "aborted-or-deadline",
      );
      return settlement;
    },
    async inputs(
      deadline: number | undefined,
      observedInputs?: readonly SessionControllerInput[],
    ): Promise<boolean> {
      // Raw preparation can own the mailbox before an active operation exists.
      // Fencing may admit a successor while the old producer retains cleanup custody.
      const changed = lifecycle(controller).changed.promise;
      const inputs =
        observedInputs ??
        controller.mailbox?.entries.filter((input) => !input.claim?.operation?.admissionRetired) ??
        [];
      const resumed = Promise.race([
        changed,
        Promise.allSettled(inputs.map((input) => input.settlement.promise)),
      ]).then(() => true);
      try {
        return deadline === undefined
          ? await racePromiseWithAbortSignal(resumed, params.upstreamAbortSignal)
          : await raceWithTimeout(resumed, Math.max(0, deadline - Date.now()), () => false, {
              ref: false,
              signal: params.upstreamAbortSignal,
              onAbort: () => false,
            });
      } catch (error) {
        if (!params.upstreamAbortSignal?.aborted) {
          throw error;
        }
        return false;
      }
    },
  };
}
