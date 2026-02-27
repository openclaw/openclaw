/**
 * In-memory flag to prevent new messages from being processed during a powernap.
 *
 * Set to `true` right before sessions are reset; the gateway restart that follows
 * clears it implicitly (process restarts → fresh module state).  If restart is
 * disabled, the flag is cleared explicitly after the reset completes.
 */
let draining = false;

export function setPowernapDraining(active: boolean): void {
  draining = active;
}

export function isPowernapDraining(): boolean {
  return draining;
}
