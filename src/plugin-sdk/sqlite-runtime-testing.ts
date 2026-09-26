// Private local-only SQLite lifecycle helpers for first-party tests.

import {
  appendTranscriptEvent,
  type SessionTranscriptAccessScope,
  type TranscriptEvent,
} from "../config/sessions/session-accessor.js";

/** Appends a raw SQLite transcript event for first-party tests only. */
export async function appendSqliteSessionTranscriptEventForTest(
  params: SessionTranscriptAccessScope & { event: TranscriptEvent },
): Promise<void> {
  await appendTranscriptEvent(params, params.event);
}

export { withSessionHistoryBudgetSweepsForTest } from "../config/sessions/session-history-budget.test-support.js";
export { drainSessionDiskBudgetWorkers } from "../config/sessions/disk-budget-runtime.js";
export { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
export {
  appendSqliteTrajectoryRuntimeEvents,
  loadSqliteTrajectoryRuntimeEvents,
  type SqliteTrajectoryRuntimeScope,
} from "../trajectory/runtime-store.sqlite.js";
export { createTrajectoryRuntimeRecorder as createTrajectoryRuntimeRecorderForTest } from "../trajectory/runtime.js";
export { exportTrajectoryBundle as exportTrajectoryBundleForTest } from "../trajectory/export.js";
export { type TrajectoryEvent as SqliteTrajectoryRuntimeEventForTest } from "../trajectory/types.js";
export {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
export {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";

export { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
