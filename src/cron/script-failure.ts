import type {
  CronFailureNotificationDetail,
  CronRunErrorClassification,
  CronTriggerFailureCode,
} from "./types.js";

/**
 * A script failure is an ordinary run failure: the job stays scheduled and its next run
 * tries again. Only timeouts and an unavailable runtime are transient retry causes.
 */
function classifyCronScriptFailure(
  code: CronTriggerFailureCode,
): CronRunErrorClassification | undefined {
  if (code === "timeout") {
    return { kind: "reason", reason: "timeout" };
  }
  if (code === "runtime_unavailable") {
    return { kind: "reason", reason: "server_error" };
  }
  // An abort ends this attempt; it says nothing about the job, so the job stays scheduled.
  if (code === "aborted") {
    return { kind: "aborted" };
  }
  return undefined;
}

/** Authors matched retry policy and safe notification detail from one closed code. */
export function cronScriptFailureMetadata(
  source: Extract<CronFailureNotificationDetail, { kind: "script-failure" }>["source"],
  code: CronTriggerFailureCode,
) {
  const errorClassification = classifyCronScriptFailure(code);
  return {
    ...(errorClassification ? { errorClassification } : {}),
    failureNotificationDetail: { kind: "script-failure" as const, source, code },
  };
}
