import { normalizeOptionalString } from "./string-coerce.js";

/**
 * Shared classifier for transient gateway lifecycle / readiness errors.
 *
 * All three subagent gateway-call paths (spawn preflight, announce finalize,
 * registry sweep delete) retry on these strings.  Having a single source of
 * truth prevents silent divergence (as happened when the announce path used
 * a different classifier that only covered delivery errors).
 */
const GATEWAY_LIFECYCLE_RETRYABLE_PATTERNS = [
  "gateway timeout",
  "gateway closed",
  "handshake timeout",
  "closed before connect",
  "not yet ready to accept connections",
] as const;

/**
 * Returns true when the error string matches a known transient gateway
 * lifecycle / readiness failure that warrants bounded retry.
 */
export function isGatewayLifecycleRetryableError(error: unknown): boolean {
  const lowered = normalizeOptionalString(
    typeof error === "string" ? error : error instanceof Error ? error.message : undefined,
  )?.toLowerCase();
  if (!lowered) {
    return false;
  }
  return GATEWAY_LIFECYCLE_RETRYABLE_PATTERNS.some((pattern) => lowered.includes(pattern));
}
