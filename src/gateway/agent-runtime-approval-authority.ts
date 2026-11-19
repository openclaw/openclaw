import { validateAgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import { isMessageActionTurnCurrent } from "./message-action-turn-capability.js";
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
    return isMessageActionTurnCurrent(identity);
  };
}
