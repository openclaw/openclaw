import type { FailoverReason } from "../agents/failover/signal.js";
import type { CronFailureNotificationDetail, CronTriggerFailureCode } from "./types.js";

const GENERIC_FAILURE_DETAIL = "Check automation history for details.";

/**
 * Operator-facing recovery guidance keyed by the stuck-session recovery
 * classification (e.g. `blocked_tool_call`). Precise values come from diagnostics;
 * `semantic_stall` and `execution_deadline` are the watchdog decision fallbacks when
 * no classification was supplied. Unknown classifications use the generic fallback.
 */
const AGENT_STALL_RECOVERY_GUIDANCE: Record<string, string[]> = {
  blocked_tool_call: [
    "The agent was blocked waiting on a tool call that made no progress.",
    "Review the tool's permissions and any blocked invocation, then rerun the automation.",
  ],
  stalled_agent_run: [
    "The agent run made no recoverable progress.",
    "Review the run transcript for a loop or ambiguous instruction, then rerun with a narrower task if needed.",
  ],
  semantic_stall: [
    "The agent made no semantic progress before the stall deadline.",
    "Review the run transcript and simplify the task, then rerun.",
  ],
  execution_deadline: [
    "The run exceeded its execution deadline.",
    "Raise the automation's execution timeout or simplify the task, then rerun.",
  ],
};

const AGENT_STALL_GENERIC_GUIDANCE = [
  "The agent run was stopped because its session became stuck.",
  "Check the automation history for details, then rerun if appropriate.",
];

const SCRIPT_FAILURE_COPY = {
  aborted: "was aborted",
  invalid_input: "received invalid input",
  runtime_unavailable: "runtime is unavailable",
  timeout: "timed out",
  output_limit_exceeded: "exceeded its output limit",
  snapshot_limit_exceeded: "exceeded its state limit",
  internal_error: "failed internally",
  tool_budget_exceeded: "exceeded its tool budget",
} satisfies Record<Exclude<CronTriggerFailureCode, "plugin_reload_failed">, string>;

/** Renders only classified reasons or closed producer-authored failure facts. */
export function cronFailureDetailLines(
  errorReason: FailoverReason | undefined,
  failureNotificationDetail?: CronFailureNotificationDetail,
): string[] {
  if (errorReason === "billing" || errorReason === "server_error") {
    return [
      `Cause: ${errorReason}`,
      errorReason === "billing"
        ? "Ask the provider account owner to resolve the billing error, or choose another provider for this automation, then run it again."
        : "The AI service is having trouble. Wait a moment and run the automation again, or choose another provider.",
    ];
  }
  if (errorReason) {
    if (errorReason === "route_unavailable") {
      return [
        `Cause: ${errorReason}`,
        "The provider cannot serve this model right now. Choose another model for this automation or ask the provider operator to restore the route, then run it again.",
      ];
    }
    return errorReason === "model_not_found"
      ? [
          `Cause: ${errorReason}`,
          "Run `openclaw doctor --fix` to repair provider-declared retired model references.",
          "Choose a supported model for this automation or remove its model override to use the agent default. If the agent default is unavailable, update it too.",
        ]
      : [`Cause: ${errorReason}`];
  }
  if (!failureNotificationDetail) {
    return [GENERIC_FAILURE_DETAIL];
  }
  if (failureNotificationDetail.kind === "command-exit") {
    return [`Cause: command exited with code ${failureNotificationDetail.exitCode}`];
  }
  if (failureNotificationDetail.kind === "command-timeout") {
    return [
      failureNotificationDetail.mode === "wall-clock"
        ? "Cause: command timed out"
        : "Cause: command stopped after producing no output",
    ];
  }
  if (failureNotificationDetail.kind === "agent-stall") {
    const { classification } = failureNotificationDetail;
    const guidance = AGENT_STALL_RECOVERY_GUIDANCE[classification] ?? AGENT_STALL_GENERIC_GUIDANCE;
    return [`Cause: ${classification}`, ...guidance];
  }
  const label =
    failureNotificationDetail.source === "payload" ? "automation script" : "trigger script";
  if (failureNotificationDetail.code === "plugin_reload_failed") {
    return [
      "Cause: tools could not be refreshed after a plugin reload.",
      `The ${label} did not run. Automatic setup recovery failed.`,
      "Check automation history and plugin status, then retry the automation.",
    ];
  }
  return [`Cause: ${label} ${SCRIPT_FAILURE_COPY[failureNotificationDetail.code]}`];
}
