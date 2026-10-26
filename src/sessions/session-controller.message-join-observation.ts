import type { SessionEntry } from "../config/sessions/types.js";
import { captureReplyExecutionSelection } from "./session-controller.execution-selection.js";

/** Historical observations belong to the selected policy binding, not a later session read. */
export function captureReplyMessageJoinObservation(params: {
  run: Parameters<typeof captureReplyExecutionSelection>[0]["run"];
  sessionEntry: Partial<SessionEntry> | undefined;
}) {
  return {
    executionSelection: captureReplyExecutionSelection(params),
    // An empty captured tuple is different from unavailable historical capture.
    recoveryDeliveryClaim: {
      restartRecoveryDeliveryRunId: params.sessionEntry?.restartRecoveryDeliveryRunId,
      restartRecoveryDeliverySourceRunId: params.sessionEntry?.restartRecoveryDeliverySourceRunId,
    },
  };
}

export type ReplyMessageJoinObservation = ReturnType<typeof captureReplyMessageJoinObservation>;
