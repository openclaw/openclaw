import {
  HARNESS_UPDATE_REQUIRED_CODE,
  type RunFailureCause,
} from "../../../../src/shared/run-failure-notice.js";

const ROUTINE_FAILURES = new Set([
  "auth",
  "auth_permanent",
  "auth_refresh",
  "auth_scope",
  "auth_html",
  "auth_invalid_token",
  "refresh_contention",
  "refresh_timeout",
  "callback_timeout",
  "billing",
  "rate_limit",
  "overloaded",
  "server_error",
  "timeout",
  "dns",
  "proxy",
  "tls_certificate",
  "upstream_html",
  "model_not_found",
  "route_unavailable",
  "session_expired",
  "context_overflow",
  "context_length",
  "refusal",
  "sandbox_blocked",
  "state_contention",
]);

export function shouldReportRunFailure(cause: RunFailureCause | undefined): boolean {
  const kinds = [cause?.errorKind, cause?.failoverReason, cause?.providerRuntimeFailureKind].filter(
    (kind) => kind !== undefined,
  );
  return (
    cause?.stopReason === "aborted-partial-persistence-failed" ||
    kinds.some(
      (kind) =>
        !ROUTINE_FAILURES.has(kind) &&
        !(kind === "gateway_storage" && cause?.errorKind === "state_contention"),
    ) ||
    (kinds.length === 0 &&
      cause?.code !== HARNESS_UPDATE_REQUIRED_CODE &&
      cause?.code !== "model_request_policy_denied")
  );
}
