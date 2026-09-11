import type { ChatRunStartupPhase } from "../../../packages/gateway-protocol/src/index.js";
import type { EmbeddedAgentExecutionPhase } from "../../agents/embedded-agent-runner/execution-phase.js";

export function resolveRunStartupPhase(
  phase: EmbeddedAgentExecutionPhase,
): ChatRunStartupPhase | undefined {
  switch (phase) {
    case "runner_entered":
    case "workspace":
    case "runtime_plugins":
      return "preparing_workspace";
    case "before_agent_reply":
    case "model_resolution":
    case "auth":
    case "context_engine":
    case "attempt_dispatch":
    case "context_assembled":
      return "preparing_context";
    case "turn_accepted":
    case "process_spawned":
    case "model_call_started":
      return "starting_model";
    case "tool_execution_started":
    case "assistant_output_started":
      return undefined;
  }
  return undefined;
}

/** Projects closed execution independently of later reply delivery. */
export function resolveAgentTurnExecutionStatus(
  outcome?: { kind: "aborted" | "rejected" } | { kind: "settled"; status: "ok" | "failed" },
) {
  if (outcome?.kind === "settled") {
    return outcome.status;
  }
  return outcome?.kind === "aborted" ? "cancelled" : "failed";
}
