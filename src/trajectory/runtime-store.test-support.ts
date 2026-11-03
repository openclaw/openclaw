import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  beginTrajectoryRuntimeRetention as beginRetention,
  selectTrajectoryRuntimeRetentionBatch as selectBatch,
  deleteTrajectoryRuntimeRetention as deleteBatch,
  prepareTrajectoryRuntimeRetention as prepareRetention,
  trajectoryRuntimeRetentionDue as retentionDue,
  trajectoryRuntimeRetentionState as retentionState,
} from "./runtime-retention.sqlite.js";
import type {
  SqliteTrajectoryRuntimeAppend,
  SqliteTrajectoryRuntimeScope,
} from "./runtime-store.contract.js";
import { appendSqliteTrajectoryRuntimeEventsWithWriter as appendWithWriter } from "./runtime-store.sqlite.js";
import type { TrajectoryEvent } from "./types.js";

const log = createSubsystemLogger("trajectory");

/** Synchronous fixture writer; runtime sinks use their worker or actor owner. */
export function appendSqliteTrajectoryRuntimeEvents(
  scope: SqliteTrajectoryRuntimeScope & Pick<SqliteTrajectoryRuntimeAppend, "discardPrevious">,
  events: readonly TrajectoryEvent[],
): void {
  const serialized = events.map((event) => ({
    runId: event.runId,
    ts: event.ts,
    line: JSON.stringify(event),
  }));
  if (events.length === 0) {
    return;
  }
  const options = toDatabaseOptions(resolveSqliteReadScope(scope));
  const write = <T>(label: string, operation: (database: OpenClawAgentDatabase) => T): T =>
    runOpenClawAgentWriteTransaction(
      (database) => {
        scope.assertCommitAllowed?.();
        const result = operation(database);
        scope.assertCommitAllowed?.();
        return result;
      },
      options,
      { operationLabel: label },
    );
  const input = { ...scope, events: serialized };
  const { database } = appendWithWriter(input, openOpenClawAgentDatabase(options), write);
  const state = retentionState(database);
  const now = Date.now();
  // A nested append cannot commit maintenance independently of its caller.
  if (!database.db.isTransaction && retentionDue(state, now)) {
    const lease = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(lease, 0, 1);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const selection: Parameters<typeof selectBatch>[1] = {
          sweepId: beginRetention(database.db, lease),
          snapshot: prepareRetention(database.db, input, now),
        };
        for (;;) {
          const batch = selectBatch(database.db, selection);
          delete selection.snapshot;
          const result = batch.refresh
            ? deleteBatch(database, batch)
            : write("trajectory.runtime.retention.delete", (current) =>
                deleteBatch(current, batch),
              );
          if (result.complete) {
            state.sweptAt = now;
            return;
          }
          if (result.refresh) {
            break;
          }
        }
      }
    } catch (error) {
      log.warn(`Trajectory retention deferred until the next append: ${String(error)}`);
    } finally {
      Atomics.store(lease, 0, 0);
    }
  }
}

export const trajectoryEventBytes = (events: readonly TrajectoryEvent[], initial = 0) =>
  events.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1, initial);

export function createTrajectoryEvent(options: {
  payloadSize?: number;
  runId?: string;
  seq?: number;
  sessionId?: string;
  ts?: string;
  type: string;
}): TrajectoryEvent {
  const sessionId = options.sessionId ?? "session-1";
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: sessionId,
    source: "runtime",
    type: options.type,
    ts: options.ts ?? "2026-07-03T00:00:00.000Z",
    seq: options.seq ?? 1,
    sourceSeq: options.seq ?? 1,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    runId: options.runId ?? "run-1",
    data: { payload: "x".repeat(options.payloadSize ?? 120) },
  };
}
