import {
  isContinuationDelegateFlow,
  scrubStoredDelegateAttachmentState,
} from "../../tasks/task-flow-continuation-state.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import {
  listTaskFlowsForOwnerKey,
  updateFlowRecordByIdExpectedRevision,
} from "../../tasks/task-flow-runtime-internal.js";
import {
  isPostCompactionDelegateFlow,
  readAcceptedDelegateChildSessionKey,
} from "./delegate-flow-store.js";
import { isContinuationWorkFlow } from "./work-flow-state.js";

const MAX_SESSION_RESET_CANCELLATION_ATTEMPTS = 8;

export class SessionContinuationResetError extends Error {
  constructor(flowId: string, reason: string) {
    super(`Session reset could not cancel continuation flow ${flowId}: ${reason}. Retry.`);
    this.name = "SessionContinuationResetError";
  }
}

function isResettableContinuationFlow(flow: TaskFlowRecord): boolean {
  const handedOffPostCompaction =
    flow.status === "succeeded" &&
    isPostCompactionDelegateFlow(flow) &&
    readAcceptedDelegateChildSessionKey(flow) === undefined;
  return (
    (isContinuationWorkFlow(flow) || isContinuationDelegateFlow(flow)) &&
    (flow.status === "queued" || flow.status === "running" || handedOffPostCompaction)
  );
}

/** Terminalize durable continuation work owned by one reset session. */
export function cancelSessionContinuations(sessionKey: string): void {
  const flows = listTaskFlowsForOwnerKey(sessionKey).filter(isResettableContinuationFlow);
  const endedAt = Date.now();
  for (const flow of flows) {
    let current = flow;
    for (let attempt = 0; attempt < MAX_SESSION_RESET_CANCELLATION_ATTEMPTS; attempt += 1) {
      const result = updateFlowRecordByIdExpectedRevision({
        flowId: current.flowId,
        expectedRevision: current.revision,
        patch: {
          status: "cancelled",
          currentStep: "Cancelled by session reset",
          waitJson: null,
          blockedTaskId: null,
          blockedSummary: null,
          cancelRequestedAt: endedAt,
          endedAt,
          updatedAt: endedAt,
          ...(isContinuationDelegateFlow(current)
            ? { stateJson: scrubStoredDelegateAttachmentState(current.stateJson) }
            : {}),
        },
      });
      if (result.applied || (result.current && !isResettableContinuationFlow(result.current))) {
        break;
      }
      if (
        result.reason === "revision_conflict" &&
        result.current &&
        attempt + 1 < MAX_SESSION_RESET_CANCELLATION_ATTEMPTS
      ) {
        current = result.current;
        continue;
      }
      throw new SessionContinuationResetError(current.flowId, result.reason);
    }
  }
}
