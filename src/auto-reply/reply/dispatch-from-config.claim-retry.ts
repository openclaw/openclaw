import {
  ReplyRunLifecycleAdmissionBlockedError,
  type SessionControllerMailboxClaim,
} from "../../sessions/session-controller.contracts.js";
import { deferSessionControllerClaimBeforeExecution } from "../../sessions/session-controller.mailbox-claim.js";
import { releaseSessionControllerClaim } from "../../sessions/session-controller.mailbox.js";

// Lifecycle admission must not import the upstream prepared-dispatch state graph.
/** Release only a proven pre-execution refusal while preserving its exact source and FIFO order. */
export async function deferLifecycleBlockedDispatchClaim(
  error: unknown,
  claim: SessionControllerMailboxClaim | undefined,
): Promise<ReplyRunLifecycleAdmissionBlockedError | undefined> {
  if (
    !(error instanceof ReplyRunLifecycleAdmissionBlockedError) ||
    !claim ||
    claim.operation ||
    !deferSessionControllerClaimBeforeExecution(claim)
  ) {
    return undefined;
  }
  releaseSessionControllerClaim(claim);
  await claim.settlement.promise;
  return error;
}
