// Coordinates graceful shutdown for local TUI runs.
import {
  MAX_TIMER_TIMEOUT_MS,
  parseStrictNonNegativeInteger,
} from "@openclaw/normalization-core/number-coercion";

// Local TUI runs get extra shutdown time because embedded agents/providers may still be closing.
const LOCAL_RUN_SHUTDOWN_GRACE_MS = 120_000;
const TUI_SHUTDOWN_HARD_EXIT_MS = 2_000;

/** Resolves the hard-exit grace period for local TUI shutdown. */
export function resolveLocalRunShutdownGraceMs(): number {
  const raw = process.env.OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS?.trim();
  const parsed = parseStrictNonNegativeInteger(raw);
  if (parsed !== undefined) {
    return Math.min(parsed, MAX_TIMER_TIMEOUT_MS);
  }
  return LOCAL_RUN_SHUTDOWN_GRACE_MS;
}

/** Resolves the full deadline before a local TUI may be force-exited. */
export function resolveLocalRunShutdownHardExitMs(): number {
  return TUI_SHUTDOWN_HARD_EXIT_MS + resolveLocalRunShutdownGraceMs();
}

export function resolveTuiShutdownDeadlineMs(localMode: boolean): number {
  return localMode ? resolveLocalRunShutdownHardExitMs() : TUI_SHUTDOWN_HARD_EXIT_MS;
}
