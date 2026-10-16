import { validateAgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import { resolveMessageActionTurnCapability } from "./message-action-turn-capability.js";
import {
  captureWorkerTurnClaimCurrentness,
  type WorkerTurnExecutionIdentityStore,
} from "./worker-environments/placement-turn-claim-events.js";

export type AgentRuntimeApprovalAuthorityValidator = (identity: AgentRuntimeIdentity) => boolean;

/** Builds the use-time approval gate from the run owner and canonical worker store. */
export function createAgentRuntimeApprovalAuthorityValidator(
  placements?: WorkerTurnExecutionIdentityStore,
): AgentRuntimeApprovalAuthorityValidator {
  return (identity) => {
    const authority = identity.delegatedAuthority;
    if (authority.kind === "worker") {
      const isCurrent =
        placements && captureWorkerTurnClaimCurrentness(placements, authority.turnClaim, authority);
      if (!isCurrent?.()) {
        return false;
      }
    } else if (!validateAgentRunDelegatedAuthority(authority)) {
      return false;
    }
    const messageActionContext = identity.messageActionContext;
    if (!messageActionContext) {
      return true;
    }
    if (!messageActionContext.turnCapability) {
      return false;
    }
    return Boolean(
      resolveMessageActionTurnCapability({
        token: messageActionContext.turnCapability,
        agentId: identity.agentId,
        runId: identity.operationalRunInstance.runId,
        sessionKey: identity.sessionKey,
        sessionId: messageActionContext.sessionId,
      }),
    );
  };
}
