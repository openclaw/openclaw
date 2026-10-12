import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { readSqliteDatabaseSiblingWriteRevision } from "../infra/sqlite-database-admission.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { readSqliteNativeMutationRevision } from "../infra/sqlite-schema-facts.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db-contract.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES } from "./paths.js";
import type {
  TrajectoryRuntimeRetentionInput,
  TrajectoryRuntimeRetentionPlan,
} from "./runtime-retention.contract.js";

const RETENTION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const GLOBAL_MAX_BYTES = 512 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
const DELETE_RUN_BATCH_SIZE = 16;
type Run = TrajectoryRuntimeRetentionPlan["runs"][number];
type RetentionState = { sweptAt?: number; pending?: Promise<void> };
const states = new WeakMap<OpenClawAgentDatabase, RetentionState>();
type Sweep = {
  id: string;
  lease: Int32Array;
  version: number | undefined;
  nativeChanges: boolean;
  changes: number | undefined;
  plan?: TrajectoryRuntimeRetentionPlan;
  receipts: Map<string, Run[]>;
  sessions: Map<string, Map<string | null, Run>>;
  queue: Run[];
  cursor: number;
  additions: Run[];
  totalBytes: number;
  expiredRuns: number;
  unprotectedRuns: number;
};
const sweeps = new WeakMap<DatabaseSync, Sweep>();
const observedConnections = new WeakSet<DatabaseSync>();

export function trajectoryRuntimeRetentionState(database: OpenClawAgentDatabase) {
  let state = states.get(database);
  if (!state) {
    state = {};
    states.set(database, state);
  }
  return state;
}

export function trajectoryRuntimeRetentionDue(state: RetentionState, now: number): boolean {
  return (
    !state.pending &&
    (state.sweptAt === undefined || now < state.sweptAt || now - state.sweptAt >= SWEEP_INTERVAL_MS)
  );
}

function compareRuns(left: Run, right: Run): number {
  return (
    left.newest - right.newest ||
    left.sessionId.localeCompare(right.sessionId) ||
    (left.runId ?? "").localeCompare(right.runId ?? "") ||
    // SQL supplies native-encoding BINARY keys; JS code-unit order differs for Unicode ties.
    (left.order < right.order ? -1 : left.order > right.order ? 1 : 0)
  );
}

function readRuns(database: DatabaseSync, sessionId?: string, runId?: string | null): Run[] {
  const db = getNodeSqliteKysely<Pick<DB, "trajectory_runtime_events">>(database);
  let query = db
    .selectFrom("trajectory_runtime_events")
    .select(["session_id as sessionId", "run_id as runId"])
    .select((eb) => [
      eb.fn.max<number>("created_at").as("newest"),
      eb.fn.sum<number>(eb(eb.fn<number>("octet_length", ["event_json"]), "+", 1)).as("bytes"),
      eb.fn.countAll<number>().as("events"),
      eb.fn<string>("hex", [eb.cast("session_id", "blob")]).as("sessionOrder"),
      eb.fn<string>("hex", [eb.cast("run_id", "blob")]).as("runOrder"),
    ])
    .groupBy(["session_id", "run_id"]);
  if (sessionId !== undefined) {
    query = query.where("session_id", "=", sessionId);
  }
  if (runId !== undefined) {
    query = runId === null ? query.where("run_id", "is", null) : query.where("run_id", "=", runId);
  }
  return executeSqliteQuerySync(database, query).rows.map((row) => ({
    sessionId: row.sessionId,
    runId: row.runId,
    newest: sqliteNumber(row.newest),
    bytes: sqliteNumber(row.bytes),
    events: sqliteNumber(row.events),
    order: `${row.sessionOrder}/${row.runId === null ? "0" : `1${row.runOrder}`}`,
  }));
}

/** The read worker performs the sweep's only full-store aggregate. */
export function prepareTrajectoryRuntimeRetention(
  database: DatabaseSync,
  input: TrajectoryRuntimeRetentionInput,
  now: number,
): TrajectoryRuntimeRetentionPlan {
  return {
    sessionId: input.sessionId,
    cutoff: now - RETENTION_MAX_AGE_MS,
    maxBytes: Math.max(1, Math.floor(input.maxGlobalRuntimeBytes ?? GLOBAL_MAX_BYTES)),
    runs: readRuns(database),
  };
}

function changes(database: DatabaseSync, native: boolean): number | undefined {
  if (native) {
    return readSqliteNativeMutationRevision(database);
  }
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely(database).selectNoFrom((eb) =>
      eb.fn<number>("total_changes", []).as("changes"),
    ),
  );
  return row!.changes;
}

/** The shared lease is revoked by the coordinator before releasing its native owner. */
export function beginTrajectoryRuntimeRetention(database: DatabaseSync, lease: Int32Array): string {
  if (!observedConnections.has(database)) {
    observedConnections.add(database);
    registerNodeSqliteDisposeCallback(database, () => {
      const active = sweeps.get(database);
      if (active) {
        Atomics.store(active.lease, 0, 0);
        sweeps.delete(database);
      }
    });
  }
  // Pin the counter kind so a later tracking change cannot compare unrelated revisions.
  const nativeChanges = readSqliteNativeMutationRevision(database) !== undefined;
  const sweep: Sweep = {
    id: randomUUID(),
    lease,
    version: readSqliteDatabaseSiblingWriteRevision(database),
    nativeChanges,
    changes: changes(database, nativeChanges),
    receipts: new Map(),
    sessions: new Map(),
    queue: [],
    cursor: 0,
    additions: [],
    totalBytes: 0,
    expiredRuns: 0,
    unprotectedRuns: 0,
  };
  sweeps.set(database, sweep);
  return sweep.id;
}

function currentSweep(database: DatabaseSync): Sweep | undefined {
  const sweep = sweeps.get(database);
  if (
    sweep &&
    (Atomics.load(sweep.lease, 0) !== 1 ||
      !database.isOpen ||
      sweep.version === undefined ||
      readSqliteDatabaseSiblingWriteRevision(database) !== sweep.version ||
      changes(database, sweep.nativeChanges) !== sweep.changes)
  ) {
    sweeps.delete(database);
    return undefined;
  }
  return sweep;
}

function stageRetentionMutation(
  database: DatabaseSync,
  sweep: Sweep,
  receipt?: { sessionId: string; runs: Run[] },
) {
  const committedChanges = changes(database, sweep.nativeChanges);
  deferSqlitePostCommitPublication(database, () => {
    if (sweeps.get(database) === sweep && Atomics.load(sweep.lease, 0) === 1) {
      if (receipt) {
        sweep.receipts.set(receipt.sessionId, receipt.runs);
      }
      sweep.changes = committedChanges;
    }
  });
}

/** Capture before mutation; publish only after the enclosing transaction commits. */
export function captureTrajectoryRuntimeRetentionMutation(database: DatabaseSync) {
  const sweep = currentSweep(database);
  if (!sweep) {
    return undefined;
  }
  return (sessionId: string) => {
    // Session trimming has already bounded this summary to the retained session window.
    stageRetentionMutation(database, sweep, { sessionId, runs: readRuns(database, sessionId) });
  };
}

/** Session metadata upserts preserve trajectory rows and need only a committed mutation counter. */
export function captureTrajectoryRuntimeRetentionMetadataMutation(database: DatabaseSync) {
  const sweep = currentSweep(database);
  return sweep ? () => stageRetentionMutation(database, sweep) : undefined;
}

function account(sweep: Sweep, run: Run, sign: number) {
  sweep.totalBytes += sign * run.bytes;
  if (run.sessionId !== sweep.plan!.sessionId) {
    sweep.unprotectedRuns += sign;
    sweep.expiredRuns += sign * Number(run.newest < sweep.plan!.cutoff);
  }
}

function replaceSession(sweep: Sweep, sessionId: string, rows: Run[]) {
  const previous = sweep.sessions.get(sessionId);
  const next = new Map<string | null, Run>();
  for (const row of rows) {
    const old = previous?.get(row.runId);
    const run =
      old && old.newest === row.newest && old.bytes === row.bytes && old.events === row.events
        ? old
        : row;
    next.set(run.runId, run);
    if (run !== old) {
      account(sweep, run, 1);
      if (run.sessionId !== sweep.plan!.sessionId) {
        sweep.additions.push(run);
      }
    }
  }
  for (const old of previous?.values() ?? []) {
    if (next.get(old.runId) !== old) {
      account(sweep, old, -1);
    }
  }
  sweep.sessions.set(sessionId, next);
}

/** Reconcile receipts and advance the sorted cursor before acquiring the writer lock. */
export function selectTrajectoryRuntimeRetentionBatch(
  database: DatabaseSync,
  input: { sweepId: string; snapshot?: TrajectoryRuntimeRetentionPlan },
) {
  const sweep = currentSweep(database);
  const runs: Run[] = [];
  if (!sweep || sweep.id !== input.sweepId) {
    return { sweepId: input.sweepId, runs, refresh: true as const };
  }
  if (input.snapshot && !sweep.plan) {
    sweep.plan = { ...input.snapshot, runs: [] };
    const sessions = new Map<string, Run[]>();
    for (const run of input.snapshot.runs) {
      const rows = sessions.get(run.sessionId) ?? [];
      rows.push(run);
      sessions.set(run.sessionId, rows);
    }
    for (const [sessionId, rows] of sessions) {
      replaceSession(sweep, sessionId, sweep.receipts.get(sessionId) ?? rows);
    }
    for (const [sessionId, rows] of sweep.receipts) {
      if (!sessions.has(sessionId)) {
        replaceSession(sweep, sessionId, rows);
      }
    }
    sweep.queue = sweep.additions.toSorted(compareRuns);
    sweep.additions = [];
  } else if (sweep.plan) {
    for (const [sessionId, rows] of sweep.receipts) {
      replaceSession(sweep, sessionId, rows);
    }
  }
  sweep.receipts.clear();
  sweep.additions.sort(compareRuns);
  let bytes = 0;
  while (runs.length < DELETE_RUN_BATCH_SIZE) {
    const queued = sweep.queue[sweep.cursor];
    const added = sweep.additions[0];
    const useAdded = added && (!queued || compareRuns(added, queued) < 0);
    const run = useAdded ? added : queued;
    if (!run) {
      break;
    }
    if (sweep.sessions.get(run.sessionId)?.get(run.runId) !== run) {
      if (useAdded) {
        sweep.additions.shift();
      } else {
        sweep.cursor++;
      }
      continue;
    }
    if (runs.length && bytes + run.bytes > TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES) {
      break;
    }
    if (useAdded) {
      sweep.additions.shift();
    } else {
      sweep.cursor++;
    }
    runs.push(run);
    bytes += run.bytes;
  }
  return { sweepId: input.sweepId, runs };
}

/** Only the handed-off batch is queried under the writer lock. */
export function deleteTrajectoryRuntimeRetention(
  database: OpenClawAgentDatabase,
  batch: ReturnType<typeof selectTrajectoryRuntimeRetentionBatch>,
) {
  const sweep = batch.refresh ? undefined : currentSweep(database.db);
  if (!sweep?.plan || sweep.id !== batch.sweepId) {
    return { complete: false, refresh: true, deleted: 0, invalidated: 0, totalBytes: 0 };
  }
  const db = getNodeSqliteKysely<Pick<DB, "trajectory_runtime_events">>(database.db);
  let totalBytes = sweep.totalBytes;
  let expiredRuns = sweep.expiredRuns;
  const deleted: Run[] = [];
  let invalidated = 0;
  for (const run of batch.runs) {
    if (
      run.sessionId === sweep.plan.sessionId ||
      (run.newest >= sweep.plan.cutoff && totalBytes <= sweep.plan.maxBytes)
    ) {
      continue;
    }
    const current = readRuns(database.db, run.sessionId, run.runId)[0];
    if (
      current?.newest !== run.newest ||
      current.bytes !== run.bytes ||
      current.events !== run.events
    ) {
      invalidated++;
      break;
    }
    executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("trajectory_runtime_events")
        .where("session_id", "=", run.sessionId)
        .where("run_id", run.runId === null ? "is" : "=", run.runId),
    );
    totalBytes -= run.bytes;
    expiredRuns -= Number(run.newest < sweep.plan.cutoff);
    deleted.push(run);
  }
  const committedChanges = changes(database.db, sweep.nativeChanges);
  deferSqlitePostCommitPublication(database.db, () => {
    for (const run of deleted) {
      sweep.sessions.get(run.sessionId)?.delete(run.runId);
      account(sweep, run, -1);
    }
    sweep.changes = committedChanges;
    if (invalidated) {
      sweeps.delete(database.db);
    }
  });
  const complete =
    expiredRuns === 0 &&
    (totalBytes <= sweep.plan.maxBytes || deleted.length === sweep.unprotectedRuns);
  return { complete, refresh: invalidated > 0, deleted: deleted.length, invalidated, totalBytes };
}
