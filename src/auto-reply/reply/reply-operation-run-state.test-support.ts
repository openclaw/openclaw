import type { ReplyOperationRunState } from "../../sessions/session-controller.contracts.js";
import { isReplyOperationSuperseded } from "./reply-operation-abort.js";

export function resolveReplyOperationAgentTurn(state: ReplyOperationRunState | undefined) {
  return isReplyOperationSuperseded(state?.agentTurnOwner) ? "superseded" : state?.agentTurn;
}
