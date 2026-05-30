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

export type ClearSessionResetRuntimeStateParams = {
  sessionKeys: Array<string | undefined>;
  retiredSessionIds?: Array<string | undefined>;
  retiredSessionKeys?: Array<string | undefined>;
  clearRetiredDiagnosticActivity?: boolean;
};

type RetiredSessionDiagnosticRef = {
  sessionId?: string;
  sessionKey?: string;
};

const emptyDiagnosticActivityResult = (): ClearDiagnosticSessionActivityResult => ({
  activeEmbeddedRunsCleared: 0,
  activeToolsCleared: 0,
  activeModelCallsCleared: 0,
  activitiesCleared: 0,
});

export function clearRetiredSessionDiagnosticActivity(
  retiredSessionRefs: Array<RetiredSessionDiagnosticRef | string | undefined>,
): ClearDiagnosticSessionActivityResult {
  return retiredSessionRefs.reduce<ClearDiagnosticSessionActivityResult>((acc, ref) => {
    const sessionRef = typeof ref === "string" ? { sessionId: ref } : ref;
    const result = clearDiagnosticSessionActivity({
      sessionId: sessionRef?.sessionId,
      sessionKey: sessionRef?.sessionKey,
      reason: "session_reset",
    });
    acc.activeEmbeddedRunsCleared += result.activeEmbeddedRunsCleared;
    acc.activeToolsCleared += result.activeToolsCleared;
    acc.activeModelCallsCleared += result.activeModelCallsCleared;
    acc.activitiesCleared += result.activitiesCleared;
    return acc;
  }, emptyDiagnosticActivityResult());
}

export function clearSessionResetRuntimeState({
  sessionKeys,
  retiredSessionIds = [],
  retiredSessionKeys = [],
  clearRetiredDiagnosticActivity = true,
}: ClearSessionResetRuntimeStateParams): ClearSessionResetRuntimeStateResult {
  const cleared = clearSessionQueues([...sessionKeys, ...retiredSessionIds]);
  let systemEventsCleared = 0;

  for (const key of cleared.keys) {
    systemEventsCleared += drainSystemEventEntries(key).length;
  }

  const diagnosticActivityCleared = clearRetiredDiagnosticActivity
    ? clearRetiredSessionDiagnosticActivity([
        ...retiredSessionIds.map((sessionId) => ({ sessionId })),
        ...retiredSessionKeys.map((sessionKey) => ({ sessionKey })),
      ])
    : emptyDiagnosticActivityResult();

  return {
    ...cleared,
    systemEventsCleared,
    diagnosticActivityCleared,
  };
}
