import type { SessionEntry } from "./types.js";

/**
 * A stop or supersede in this generation leaves `abortedLastRun` beside a live
 * delivery claim, with a killed outcome or none yet when the stop flag lands first.
 * Without a restart mark or a fence from an earlier generation, that claim did not
 * outlive its process and is not restart-interrupted work (openclaw#1468).
 */
export function isMainSessionCurrentGenerationStop(
  entry: SessionEntry,
  lifecycleGeneration: string,
): boolean {
  return (
    (entry.status === "killed" || entry.status === undefined) &&
    entry.mainRestartRecovery === undefined &&
    entry.restartRecoveryRuns?.some((run) => run.lifecycleGeneration !== lifecycleGeneration) !==
      true
  );
}
