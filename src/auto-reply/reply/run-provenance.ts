import type { DiagnosticRunFireReason } from "../../infra/diagnostic-events.js";
import type { GetReplyOptions } from "../types.js";

// Continuation work/delegate wakes are heartbeat-like for hooks and model
// overrides, but must not flip `isHeartbeat` because admission treats that as
// skippable background work under active-run pressure.
export function isContinuationHeartbeatEquivalent(
  continuationTrigger:
    | Pick<GetReplyOptions, "continuationTrigger">["continuationTrigger"]
    | undefined,
): boolean {
  return continuationTrigger === "work-wake" || continuationTrigger === "delegate-return";
}

export function resolveReplyHookTrigger(
  opts?: Pick<GetReplyOptions, "continuationTrigger" | "isHeartbeat">,
): "heartbeat" | "user" {
  return opts?.isHeartbeat === true || isContinuationHeartbeatEquivalent(opts?.continuationTrigger)
    ? "heartbeat"
    : "user";
}

export function resolveReplyRunFireReason(params: {
  opts?: Pick<GetReplyOptions, "continuationTrigger" | "isHeartbeat">;
  drainsContinuationDelegateQueue?: boolean;
}): DiagnosticRunFireReason {
  if (
    params.drainsContinuationDelegateQueue === true ||
    params.opts?.continuationTrigger === "delegate-return"
  ) {
    return "continuation-chain";
  }
  if (params.opts?.continuationTrigger === "work-wake" || params.opts?.isHeartbeat === true) {
    return "timer";
  }
  return "external-trigger";
}
