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
import type { TrajectoryRuntimeRetentionPlan } from "./runtime-retention.contract.js";
import {
  beginTrajectoryRuntimeRetention,
  selectTrajectoryRuntimeRetentionBatch,
  deleteTrajectoryRuntimeRetention,
  prepareTrajectoryRuntimeRetention,
  trajectoryRuntimeRetentionDue,
  trajectoryRuntimeRetentionState,
} from "./runtime-retention.sqlite.js";
import type {
  SqliteTrajectoryRuntimeAppend,
  SqliteTrajectoryRuntimeScope,
} from "./runtime-store.contract.js";
import { appendSqliteTrajectoryRuntimeEventsWithWriter } from "./runtime-store.sqlite.js";
import type { TrajectoryEvent } from "./types.js";

const log = createSubsystemLogger("trajectory");

/** Synchronous fixture writer; runtime sinks use their worker or actor owner. */
export function appendSerializedTrajectoryRuntimeEvents(
  scope: SqliteTrajectoryRuntimeScope & Pick<SqliteTrajectoryRuntimeAppend, "discardPrevious">,
  events: SqliteTrajectoryRuntimeAppend["events"],
): void {
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
  const input = { ...scope, events };
  const { database } = appendSqliteTrajectoryRuntimeEventsWithWriter(
    input,
    openOpenClawAgentDatabase(options),
    write,
  );
  const state = trajectoryRuntimeRetentionState(database);
  const now = Date.now();
  // A nested append cannot commit maintenance independently of its caller.
  if (!database.db.isTransaction && trajectoryRuntimeRetentionDue(state, now)) {
    const lease = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(lease, 0, 1);
    try {
      let refreshes = 0;
      let sweepId = beginTrajectoryRuntimeRetention(database.db, lease);
      let snapshot: TrajectoryRuntimeRetentionPlan | undefined = prepareTrajectoryRuntimeRetention(
        database.db,
        input,
        now,
      );
      for (;;) {
        const batch = selectTrajectoryRuntimeRetentionBatch(database.db, { sweepId, snapshot });
        snapshot = undefined;
        const result = batch.refresh
          ? deleteTrajectoryRuntimeRetention(database, batch)
          : write("trajectory.runtime.retention.delete", (current) =>
              deleteTrajectoryRuntimeRetention(current, batch),
            );
        if (result.complete) {
          state.sweptAt = now;
          break;
        }
        if (result.refresh) {
          if (++refreshes > 1) {
            break;
          }
          sweepId = beginTrajectoryRuntimeRetention(database.db, lease);
          snapshot = prepareTrajectoryRuntimeRetention(database.db, input, now);
        }
      }
    } catch (error) {
      log.warn(`Trajectory retention deferred until the next append: ${String(error)}`);
    } finally {
      Atomics.store(lease, 0, 0);
    }
  }
}

export function appendSqliteTrajectoryRuntimeEvents(
  scope: Parameters<typeof appendSerializedTrajectoryRuntimeEvents>[0],
  events: readonly TrajectoryEvent[],
): void {
  appendSerializedTrajectoryRuntimeEvents(
    scope,
    events.map((event) => ({ runId: event.runId, ts: event.ts, line: JSON.stringify(event) })),
  );
}

export function trajectoryEventBytes(events: readonly TrajectoryEvent[], initial = 0) {
  return events.reduce(
    (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1,
    initial,
  );
}

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
