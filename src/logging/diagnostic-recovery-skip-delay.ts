// Heartbeat-delay gate for stuck-session recovery under event-loop observer stall.

/** Diagnostics heartbeat period; recovery skip scales in multiples of this. */
export const DIAGNOSTIC_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Fixed multi-interval ceiling for default/high abort thresholds.
 * Low stuckSessionAbortMs configs scale the skip down via
 * resolveDiagnosticRecoverySkipHeartbeatDelayMs so observer-inflated ages
 * cannot cross abort while still under this 90s historical fixed cutoff.
 */
export const DIAGNOSTIC_HEARTBEAT_DELAY_RECOVERY_SKIP_MS = 3 * DIAGNOSTIC_HEARTBEAT_INTERVAL_MS;

/**
 * Heartbeat delay above which stuck-session recovery must not run on this tick.
 * Scales with the effective abort threshold so low configs stay protected; the
 * fixed multi-interval cap preserves the multi-minute observer-stall guard.
 *
 * Floored at the heartbeat interval so ordinary 30s cadence (strict `>` at the
 * call site) cannot continuously defer recovery when abort is at or below 30s.
 */
export function resolveDiagnosticRecoverySkipHeartbeatDelayMs(stuckSessionAbortMs: number): number {
  if (!Number.isFinite(stuckSessionAbortMs) || stuckSessionAbortMs <= 0) {
    return DIAGNOSTIC_HEARTBEAT_DELAY_RECOVERY_SKIP_MS;
  }
  // Floor at heartbeat interval: valid sub-interval abort configs must still
  // allow recovery on ordinary ticks. Without this floor, tickDelayMs ≈ 30s
  // always exceeds a sub-30s threshold and recovery never runs.
  return Math.min(
    DIAGNOSTIC_HEARTBEAT_DELAY_RECOVERY_SKIP_MS,
    Math.max(DIAGNOSTIC_HEARTBEAT_INTERVAL_MS, Math.floor(stuckSessionAbortMs)),
  );
}
