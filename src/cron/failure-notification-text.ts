import type { FailoverReason } from "../agents/failover/signal.js";
import type { CronFailureNotificationDetail, CronTriggerFailureCode } from "./types.js";

const GENERIC_FAILURE_DETAIL = "Cause: not recorded. The automation's run history has the details.";

/** One plain sentence per classified reason; notices never print the code itself. */
const FAILOVER_REASON_COPY: Record<FailoverReason, string> = {
  auth: "Cause: the AI provider refused the sign-in.",
  auth_permanent: "Cause: the AI provider refused the sign-in.",
  format: "Cause: the AI provider rejected the request.",
  rate_limit: "Cause: the AI provider is limiting requests right now.",
  overloaded: "Cause: the AI provider is overloaded right now.",
  billing:
    "Cause: the AI provider refused the request because of billing. Check the plan or credit, or choose another provider for this automation.",
  server_error: "Cause: the AI provider had a server error. This usually clears without action.",
  route_unavailable:
    "Cause: the AI provider cannot serve this model right now. Choose another model for this automation, or wait for the provider to restore it.",
  timeout: "Cause: the AI provider took too long to answer.",
  tls_certificate: "Cause: the AI provider's certificate could not be verified.",
  context_overflow: "Cause: the conversation was too long for the model.",
  model_not_found:
    "Cause: the model this automation uses is no longer available. Choose a supported model for it, or remove its model override to use the agent default.",
  session_expired: "Cause: the AI provider session expired.",
  empty_response: "Cause: the AI provider sent an empty answer.",
  no_error_details: "Cause: the model request failed. The run history has the details.",
  unclassified: "Cause: the model request failed. The run history has the details.",
  unknown: "Cause: the model request failed. The run history has the details.",
};

/**
 * Plain cause keyed by the stuck-session recovery classification (e.g. `blocked_tool_call`).
 * `semantic_stall` and `execution_deadline` are the watchdog decision fallbacks when no
 * classification was supplied. Unknown classifications use the generic stall line.
 */
const AGENT_STALL_COPY: Record<string, string> = {
  blocked_tool_call: "Cause: the run waited on a tool call that could not continue, so it stopped.",
  stalled_agent_run: "Cause: the run stopped making progress, so it stopped.",
  semantic_stall: "Cause: the run kept repeating the same steps, so it stopped.",
  execution_deadline: "Cause: the run was longer than its time limit, so it stopped.",
};

const AGENT_STALL_GENERIC_COPY = "Cause: the run became stuck, so it stopped.";

const SCRIPT_FAILURE_COPY = {
  aborted: "was stopped before it finished.",
  invalid_input: "received input it cannot use.",
  runtime_unavailable: "could not start because the script runner was not available.",
  timeout: "took too long, so it stopped.",
  output_limit_exceeded: "printed too much output, so it stopped.",
  snapshot_limit_exceeded: "saved too much data between checks, so it stopped.",
  internal_error: "could not run because of an OpenClaw fault, not a fault in the script.",
  tool_budget_exceeded: "made too many tool calls in one check, so it stopped.",
  script_error: "stopped with an error. The run history has its message.",
  source_unavailable: "lost the authority of the person who created it.",
} satisfies Record<Exclude<CronTriggerFailureCode, "plugin_reload_failed">, string>;

/** Renders only classified reasons or closed producer-authored failure facts. */
export function cronFailureDetailLines(
  errorReason: FailoverReason | undefined,
  failureNotificationDetail?: CronFailureNotificationDetail,
): string[] {
  if (errorReason) {
    return [FAILOVER_REASON_COPY[errorReason] ?? FAILOVER_REASON_COPY.unknown];
  }
  if (!failureNotificationDetail) {
    return [GENERIC_FAILURE_DETAIL];
  }
  if (failureNotificationDetail.kind === "invalid-target") {
    return ["Cause: the agent or conversation it runs in no longer exists."];
  }
  if (failureNotificationDetail.kind === "command-exit") {
    return [`Cause: its command exited with code ${failureNotificationDetail.exitCode}.`];
  }
  if (failureNotificationDetail.kind === "command-timeout") {
    return [
      failureNotificationDetail.mode === "wall-clock"
        ? "Cause: its command took too long, so it stopped."
        : "Cause: its command printed nothing for too long, so it stopped.",
    ];
  }
  if (failureNotificationDetail.kind === "agent-stall") {
    return [AGENT_STALL_COPY[failureNotificationDetail.classification] ?? AGENT_STALL_GENERIC_COPY];
  }
  const label =
    failureNotificationDetail.source === "payload" ? "automation script" : "trigger script";
  if (failureNotificationDetail.code === "plugin_reload_failed") {
    return [
      `Cause: tools could not be refreshed after a plugin reload, so the ${label} did not run.`,
    ];
  }
  return [`Cause: the ${label} ${SCRIPT_FAILURE_COPY[failureNotificationDetail.code]}`];
}
