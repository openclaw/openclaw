import { isReplyOperationSuperseded } from "./reply-operation-abort.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";

export function resolveReplyOperationAgentTurn(state: ReplyOperationRunState | undefined) {
  return isReplyOperationSuperseded(state?.agentTurnOwner) ? "superseded" : state?.agentTurn;
}
