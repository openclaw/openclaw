/**
 * In-memory flag to prevent new messages from being processed during a powernap.
 *
 * Set to `true` right before sessions are reset; the gateway restart that follows
 * clears it implicitly (process restarts -> fresh module state).  If restart is
 * disabled, the flag is cleared explicitly after the reset completes.
 */
let draining = false;

/** Safety timeout (ms) to auto-clear drain if restart never happens. */
export const DRAIN_SAFETY_TIMEOUT = 60_000;

let safetyTimer: ReturnType<typeof setTimeout> | undefined;

type DrainedSource = { senderId: string; channel: string };
let drainedCount = 0;
const MAX_TRACKED_SOURCES = 20;
let drainedSources: DrainedSource[] = [];

export function setPowernapDraining(active: boolean): void {
  draining = active;
  if (active) {
    // Reset tracking for new drain cycle
    drainedCount = 0;
    drainedSources = [];
    // Start safety timeout
    if (safetyTimer !== undefined) {
      clearTimeout(safetyTimer);
    }
    safetyTimer = setTimeout(() => {
      draining = false;
      safetyTimer = undefined;
    }, DRAIN_SAFETY_TIMEOUT);
  } else {
    // Clear safety timeout if drain is manually cleared
    if (safetyTimer !== undefined) {
      clearTimeout(safetyTimer);
      safetyTimer = undefined;
    }
  }
}

export function isPowernapDraining(): boolean {
  return draining;
}

export function recordDrainedMessage(senderId: string, channel: string): void {
  drainedCount++;
  if (drainedSources.length < MAX_TRACKED_SOURCES) {
    drainedSources.push({ senderId, channel });
  }
}

export function getDrainedMessageCount(): number {
  return drainedCount;
}

export function getDrainedSources(): DrainedSource[] {
  return [...drainedSources];
}
