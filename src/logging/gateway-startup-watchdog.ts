// Gateway-CLI startup watchdog: fires once if HTTP bind doesn't happen in time.
//
// When the gateway hangs anywhere between `[gateway] starting...` and
// HTTP listen-success, the only externally visible signal today is "no log
// output until kubelet SIGKILL." Every intervening step runs inside a
// `withDiagnosticPhase(name, run)` block, but those are only emitted on
// phase COMPLETION via the optional startup-trace logger. On the hang path
// nothing is ever flushed.
//
// This watchdog arms a single self-firing timer at the top of the gateway
// startup loop. If `cancelStartupWatchdog()` has not been called before the
// threshold elapses, it snapshots the currently-in-flight diagnostic phase
// stack and writes ONE structured line directly to `process.stderr`. It
// then exits \u2014 it never re-arms, never retries, never throws.
//
// Diagnostic-only. No behavior change on the happy path.
import { getActiveDiagnosticPhases } from "./diagnostic-phase.js";

const DEFAULT_THRESHOLD_MS = 60_000;
const ENV_THRESHOLD = "OPENCLAW_STARTUP_WATCHDOG_MS";

let activeTimer: ReturnType<typeof setTimeout> | undefined;
let lastEmittedLine: string | undefined;

/**
 * Parse the watchdog threshold from the environment.
 *
 * Returns:
 * - the default (`60000`) when the env var is unset or blank;
 * - `0` (disabled) when the operator sets it to `0`;
 * - `0` (disabled) when the operator sets it to a malformed value such as
 *   a negative number, `NaN`, or a non-numeric string. Malformed input is
 *   treated as an explicit "do not arm" rather than silently falling back
 *   to the default — the watchdog is diagnostic-only and the safer
 *   posture for a bad operator override is to leave it off so the
 *   misconfiguration becomes visible (no spurious watchdog lines) rather
 *   than re-arming a default the operator did not ask for.
 * - the floored positive integer otherwise.
 */
export function resolveStartupWatchdogThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_THRESHOLD];
  if (raw === undefined || raw === "") {
    return DEFAULT_THRESHOLD_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    // Defensive parsing for an external-boundary value: malformed override
    // disables the watchdog rather than silently re-arming the default.
    return 0;
  }
  return Math.floor(parsed);
}

/**
 * Render a phase name safe for inclusion in the single-line stderr
 * diagnostic. Phase names today come from string literals in source, but
 * if a future caller passes user-derived content an embedded newline or
 * quote would break the single-line parse contract operators rely on.
 *
 * `JSON.stringify` of a string produces a double-quoted token with `\n`,
 * `\r`, `"`, and `\\` escaped per JSON, which is exactly the escape set
 * we need for a stderr log line.
 */
function quotePhaseName(name: string): string {
  return JSON.stringify(name);
}

function formatPending(phases: ReadonlyArray<{ name: string; elapsedMs: number }>): string {
  if (phases.length === 0) {
    return "[]";
  }
  // Render outermost → innermost so operators reading stderr see the
  // call-tree from top to bottom. Each phase name is quoted-and-escaped so
  // an embedded newline or quote cannot break the single-line invariant.
  const items = phases.map(
    (phase) => `${quotePhaseName(phase.name)}@${phase.elapsedMs.toFixed(1)}ms`,
  );
  return `[${items.join(" ")}]`;
}

/**
 * Internal: callback executed when the watchdog fires.
 *
 * Exposed for tests only. Must remain fully synchronous \u2014 no `await`,
 * no promises, no `gatewayLog.*`. The whole point of the watchdog is to
 * surface diagnostic state when the logger or event loop is starved.
 */
export function emitStartupWatchdogFiredLine(thresholdMs: number): string {
  const phases = getActiveDiagnosticPhases();
  const stuck = phases.at(-1);
  const stuckName = stuck?.name ?? "(unknown)";
  const stuckElapsed = stuck?.elapsedMs ?? thresholdMs;
  const line = `[startup-watchdog] stuck step=${quotePhaseName(stuckName)} elapsed=${stuckElapsed.toFixed(1)}ms threshold=${thresholdMs}ms pending=${formatPending(phases)}\n`;
  // Direct stderr write \u2014 bypasses the logger so a starved/filtered
  // logging pipeline does not eat the diagnostic on the hang path.
  try {
    process.stderr.write(line);
  } catch {
    // Ignore: if stderr itself is unavailable we have no other channel.
  }
  lastEmittedLine = line;
  return line;
}

/**
 * Arm the startup watchdog. Idempotent: a second call with the timer
 * already armed is a no-op (logs an internal-debug note via the returned
 * value but does not throw).
 *
 * Returns `false` when the watchdog is disabled (`thresholdMs === 0`) or
 * when a timer is already armed; `true` when a new timer was created.
 */
export function armStartupWatchdog(opts: { thresholdMs: number }): boolean {
  const { thresholdMs } = opts;
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    return false;
  }
  if (activeTimer !== undefined) {
    return false;
  }
  activeTimer = setTimeout(() => {
    activeTimer = undefined;
    emitStartupWatchdogFiredLine(thresholdMs);
  }, thresholdMs);
  // Allow Node to exit naturally if the gateway shuts down before the
  // watchdog fires \u2014 we never want the diagnostic timer to keep the
  // process alive.
  activeTimer.unref?.();
  return true;
}

/**
 * Cancel the armed watchdog timer. Safe to call multiple times and safe
 * to call when no timer is armed. Called from the HTTP listen-success
 * path and from process shutdown.
 */
export function cancelStartupWatchdog(): void {
  if (activeTimer !== undefined) {
    clearTimeout(activeTimer);
    activeTimer = undefined;
  }
}

/**
 * Test-only: clears module state so each test starts from a known baseline.
 */
export function resetStartupWatchdogForTest(): void {
  cancelStartupWatchdog();
  lastEmittedLine = undefined;
}

/**
 * Test-only: returns the last stderr line written by the watchdog, or
 * `undefined` when it has not fired since the most recent reset.
 */
export function getLastStartupWatchdogLineForTest(): string | undefined {
  return lastEmittedLine;
}

/**
 * Test-only: returns whether a timer is currently armed.
 */
export function isStartupWatchdogArmedForTest(): boolean {
  return activeTimer !== undefined;
}
