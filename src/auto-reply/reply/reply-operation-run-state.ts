import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type {
  ReplyOperation,
  ReplyOperationRunState,
  ReplyPreRunRejectionCode,
} from "../../sessions/session-controller.contracts.js";
import { resolveAgentTurnExecutionStatus } from "./agent-runner-execution-status.js";
import { isReplyOperationSuperseded } from "./reply-operation-abort.js";
import type { SessionEventExecution } from "./session-event-contract.js";
export type {
  ReplyOperationRunState,
  ReplyPreRunRejectionCode,
} from "../../sessions/session-controller.contracts.js";

// Carries this invocation's admission decision through reply option spreads so
// heartbeat cleanup never infers it from whichever operation is active later.
export const REPLY_OPERATION_RUN_STATE = Symbol("openclaw.replyOperationRunState");

export type ReplyOptionsWithOperationRunState = {
  [REPLY_OPERATION_RUN_STATE]?: ReplyOperationRunState;
};

export function resolveReplyOperationRunState(
  options: object | undefined,
): ReplyOperationRunState | undefined {
  return (options as ReplyOptionsWithOperationRunState | undefined)?.[REPLY_OPERATION_RUN_STATE];
}

/** Either source owner can prevent its retained background work from adding delivery. */
export function resolveReplySessionEventDelivery(
  options: object | undefined,
  run: { internalEventExecution?: Pick<SessionEventExecution, "deliver"> },
): false | undefined {
  return run.internalEventExecution?.deliver === false ||
    resolveReplyOperationRunState(options)?.sessionEventDelivery === false
    ? false
    : undefined;
}

export function recordReplyOperationAgentTurn(
  states: readonly ReplyOperationRunState[] | undefined,
  owner: ReplyOperation | undefined,
  outcome?:
    | { kind: "aborted" | "rejected" }
    | {
        kind: "settled";
        status: "ok" | "failed";
        result: Pick<
          EmbeddedAgentRunResult,
          "messagingToolSentTargets" | "asyncWorkStarted" | "acceptedSessionSpawns"
        >;
      },
): void {
  for (const state of states ?? []) {
    state.agentTurn = resolveAgentTurnExecutionStatus(
      outcome ?? (owner?.result?.kind === "aborted" ? owner.result : undefined),
    );
    if (outcome?.kind === "settled") {
      state.messagingToolSentTargets = outcome.result.messagingToolSentTargets;
      state.backgroundWorkStarted = Boolean(
        outcome.result.asyncWorkStarted || outcome.result.acceptedSessionSpawns?.length,
      );
    } else if (!owner || state.agentTurnOwner !== owner) {
      state.messagingToolSentTargets = undefined;
      state.backgroundWorkStarted = false;
    }
    state.agentTurnOwner = owner;
  }
}

export function recordReplyPreRunRejection(
  state: ReplyOperationRunState | undefined,
  rejection: ReplyPreRunRejectionCode | undefined,
): void {
  if (state && rejection) {
    state.preRunRejection ??= rejection;
  }
}

export function resolveReplyOperationAgentTurn(state: ReplyOperationRunState | undefined) {
  return isReplyOperationSuperseded(state?.agentTurnOwner) ? "superseded" : state?.agentTurn;
}
