import { isMessageActionTurnCurrent } from "../message-action-turn-capability.js";
import type { GatewayClient } from "./types.js";

/**
 * The caller's message-action turn, checked where its effects happen. Run authority is
 * checked once at request start (authorizeGatewayRequestPreDispatch); the turn-capability
 * re-check is a separate check-once chain.
 */
export function captureAgentRuntimeTurnAssertion(
  client: GatewayClient | null | undefined,
): (() => void) | undefined {
  const identity = client?.internal?.agentRuntimeIdentity;
  if (!identity?.messageActionContext) {
    return undefined;
  }
  return () => {
    if (!isMessageActionTurnCurrent(identity)) {
      throw new TypeError("agent runtime authority is no longer active");
    }
  };
}
