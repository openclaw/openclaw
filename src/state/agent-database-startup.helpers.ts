import type { PendingAgentDatabaseRecovery as PendingRecovery } from "./agent-database-startup.types.js";
import { isSameOpenClawAgentDatabasePath } from "./openclaw-agent-db.paths.js";

export function recoveryTiming(recovery: PendingRecovery, now = performance.now()) {
  return {
    elapsedMs: Math.round(now - recovery.startedAt),
    phaseDurationsMs: {
      ...recovery.phaseDurationsMs,
      [recovery.phase]: Math.round(
        (recovery.phaseDurationsMs[recovery.phase] ?? 0) + now - recovery.phaseStartedAt,
      ),
    },
  };
}
export function matchesInspectionPath(
  paths: readonly string[],
  target: string,
  samePath = isSameOpenClawAgentDatabasePath,
): boolean {
  return paths.some((pathname) => {
    try {
      return samePath(pathname, target);
    } catch {
      // An uncertain sibling cannot classify this target; its own inspection reports the failure.
      return false;
    }
  });
}
