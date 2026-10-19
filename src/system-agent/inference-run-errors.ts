import type { AgentRunResultView } from "../agents/agent-run-result.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
} from "../agents/prepared-model-runtime.errors.js";
import {
  AGENT_RUN_SUPERSEDED_STOP_REASON,
  isAgentRunSupersededAbortReason,
} from "../agents/run-termination.js";

export function systemAgentTerminalFailureGuidance(result: AgentRunResultView) {
  return result.meta?.stopReason === "timeout" || result.meta?.timeoutPhase
    ? "timeout"
    : result.meta?.stopReason === AGENT_RUN_SUPERSEDED_STOP_REASON
      ? "superseded"
      : "retry";
}

export function systemAgentRuntimeFailureGuidance(error: unknown) {
  return isAgentRunSupersededAbortReason(error) ||
    error instanceof PreparedModelRuntimePublicationSupersededError
    ? "superseded"
    : error instanceof PreparedModelRuntimeOwnerNotPublishedError
      ? "runtime-unavailable"
      : undefined;
}
