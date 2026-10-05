import type { AcceptedSessionSpawn } from "../../agents/accepted-session-spawn.js";
import type { ReplyCompletion } from "../../agents/reply-completion.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { resolveReplyOperationAbortReason } from "./reply-operation-abort.js";
import { replyRunRegistry, type ReplyOperation } from "./reply-run-registry.js";

const log = createSubsystemLogger("reply/waiting-status");

export function buildWaitingStatusPayload(params: {
  completion: ReplyCompletion;
  continuationPending?: boolean;
  yieldAcknowledgment?: string;
  yielded?: boolean;
  hasVisibleMessageDelivery: boolean;
}): ReplyPayload | undefined {
  if (
    params.completion.expectation !== "required" ||
    params.completion.outcome !== "pending" ||
    (!params.yielded && !params.continuationPending) ||
    params.hasVisibleMessageDelivery
  ) {
    return undefined;
  }
  return setReplyPayloadMetadata(
    {
      text:
        params.yieldAcknowledgment?.trim() ||
        "I’m continuing this work and will send the result when it is ready.",
    },
    {
      deliverDespiteSourceReplySuppression: true,
      continuationStatus: true,
    },
  );
}

/** Bind ordinary and queued acknowledgments through the same reply-owner boundary. */
export async function attachWaitingStatusProgressContinuation(params: {
  payload: ReplyPayload;
  requesterSessionKey?: string;
  requesterAgentId?: string;
  requesterSessionId: string;
  requesterTurnRunId: string;
  requesterContinuationSettled?: boolean;
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[];
  operation: ReplyOperation;
}): Promise<void> {
  const { requesterSessionKey, requesterAgentId, acceptedSessionSpawns, operation } = params;
  if (!requesterSessionKey || !requesterAgentId || !acceptedSessionSpawns?.length) {
    return;
  }
  const operationKey = operation.key;
  const operationSessionId = operation.sessionId;
  const { createSubagentProgressContinuation } =
    await import("../../agents/subagents/registry/subagent-progress-continuation.js");
  setReplyPayloadMetadata(params.payload, {
    progressContinuation: createSubagentProgressContinuation({
      requesterSessionKey,
      requesterAgentId,
      requesterSessionId: params.requesterSessionId,
      requesterTurnRunId: params.requesterTurnRunId,
      acceptedSessionSpawns,
      assertCurrent: () => {
        const current = replyRunRegistry.get(operationKey);
        // Explicit yield has already transferred its whole cohort before the old
        // reply operation retires. The registry, not that closed execution, now
        // supplies live custody; adoption still verifies every current member.
        const retiredYield = params.requesterContinuationSettled === true && current === undefined;
        if (
          (current !== operation && !retiredYield) ||
          operation.key !== operationKey ||
          operation.sessionId !== operationSessionId ||
          resolveReplyOperationAbortReason(operation) !== undefined
        ) {
          log.debug("Progress reply owner unavailable", {
            attached: replyRunRegistry.get(operationKey) === operation,
            sameKey: operation.key === operationKey,
            sameSession: operation.sessionId === operationSessionId,
            termination: resolveReplyOperationAbortReason(operation) ?? "none",
          });
          throw new Error("Progress handoff lost its requester reply owner");
        }
      },
    }),
  });
}
