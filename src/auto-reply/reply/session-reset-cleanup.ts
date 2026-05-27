import { drainSystemEventEntries } from "../../infra/system-events.js";
import {
  clearDiagnosticSessionActivity,
  type ClearDiagnosticSessionActivityResult,
} from "../../logging/diagnostic-run-activity.js";
import { clearSessionQueues, type ClearSessionQueueResult } from "./queue/cleanup.js";

export type ClearSessionResetRuntimeStateResult = ClearSessionQueueResult & {
  systemEventsCleared: number;
  diagnosticActivityCleared: ClearDiagnosticSessionActivityResult;
};

export function clearSessionResetRuntimeState(
  keys: Array<string | undefined>,
): ClearSessionResetRuntimeStateResult {
  const cleared = clearSessionQueues(keys);
  let systemEventsCleared = 0;

  for (const key of cleared.keys) {
    systemEventsCleared += drainSystemEventEntries(key).length;
  }

  const diagnosticActivityCleared = cleared.keys.reduce<ClearDiagnosticSessionActivityResult>(
    (acc, key) => {
      const result = clearDiagnosticSessionActivity({
        sessionId: key,
        sessionKey: key,
        reason: "session_reset",
      });
      acc.activeEmbeddedRunsCleared += result.activeEmbeddedRunsCleared;
      acc.activeToolsCleared += result.activeToolsCleared;
      acc.activeModelCallsCleared += result.activeModelCallsCleared;
      acc.activitiesCleared += result.activitiesCleared;
      return acc;
    },
    {
      activeEmbeddedRunsCleared: 0,
      activeToolsCleared: 0,
      activeModelCallsCleared: 0,
      activitiesCleared: 0,
    },
  );

  return {
    ...cleared,
    systemEventsCleared,
    diagnosticActivityCleared,
  };
}
