import type { DiagnosticRunFireReason } from "../../infra/diagnostic-events.js";
import type { GetReplyOptions } from "../types.js";

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
