import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import {
  readSqliteCacheDataVersion,
  readSqliteNativeMutationRevision,
} from "../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES } from "./paths.js";
import type {
  TrajectoryRuntimeRetentionInput,
  TrajectoryRuntimeRetentionPlan,
} from "./runtime-retention.contract.js";

const RETENTION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const GLOBAL_MAX_BYTES = 512 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
const DELETE_RUN_BATCH_SIZE = 100;
type RetentionDatabase = Pick<DB, "trajectory_runtime_events">;
export type TrajectoryRuntimeRetentionRevision = {
  incarnation: string;
  dataVersion: number;
  mutationRevision: number | undefined;
};
type Run = {
  sessionId: string;
  runId: string | null;
  newest: number;
  bytes: number;
  order: number;
};
type RetentionState = { sweptAt?: number; pending?: Promise<void> };
// The native owner's lifetime bounds both cadence and any coalesced maintenance.
const states = new WeakMap<OpenClawAgentDatabase, RetentionState>();

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

export function readTrajectoryRuntimeRetentionRevision(
  database: OpenClawAgentDatabase,
): TrajectoryRuntimeRetentionRevision {
  return {
    incarnation: readOpenClawAgentDatabaseIdentity(database).incarnation,
    dataVersion: readSqliteCacheDataVersion(database.db),
    mutationRevision: readSqliteNativeMutationRevision(database.db),
  };
}

function compareRuns(left: Run, right: Run): number {
  return (
    left.newest - right.newest ||
    left.sessionId.localeCompare(right.sessionId) ||
    (left.runId ?? "").localeCompare(right.runId ?? "") ||
    left.order - right.order
  );
}

/** SQL reduces events; the aggregate retains only one bounded batch of complete runs. */
export function prepareTrajectoryRuntimeRetention(
  database: DatabaseSync,
  input: TrajectoryRuntimeRetentionInput,
  now: number,
): TrajectoryRuntimeRetentionPlan {
  const currentSessionId = input.sessionId;
  const oldest: Run[] = [];
  let totalBytes = 0;
  let order = 0;
  let worst = 0;
  database.aggregate("openclaw_trajectory_retention", {
    start: 0,
    step: (_value, sessionId, runId, newest, bytes) => {
      if (
        typeof sessionId !== "string" ||
        (runId !== null && typeof runId !== "string") ||
        (typeof newest !== "number" && typeof newest !== "bigint") ||
        (typeof bytes !== "number" && typeof bytes !== "bigint")
      ) {
        throw new Error("Trajectory retention received invalid run metadata");
      }
      const size = sqliteNumber(bytes);
      totalBytes += size;
      if (sessionId === currentSessionId) {
        return 0;
      }
      const run = { sessionId, runId, newest: sqliteNumber(newest), bytes: size, order: order++ };
      if (oldest.length < DELETE_RUN_BATCH_SIZE) {
        oldest.push(run);
        if (compareRuns(run, oldest[worst]!) > 0) {
          worst = oldest.length - 1;
        }
      } else if (compareRuns(run, oldest[worst]!) < 0) {
        oldest[worst] = run;
        worst = oldest.reduce(
          (index, candidate, next) => (compareRuns(candidate, oldest[index]!) > 0 ? next : index),
          0,
        );
      }
      return 0;
    },
  });
  const db = getNodeSqliteKysely<RetentionDatabase>(database);
  runSqliteDeferredTransactionSync(
    database,
    () =>
      executeSqliteQuerySync(
        database,
        db
          .with("runs", (qb) =>
            qb
              .selectFrom("trajectory_runtime_events")
              .select(["session_id", "run_id"])
              .select((eb) => [
                eb.fn.max<number>("created_at").as("newest"),
                eb.fn
                  .sum<number>(eb(eb.fn<number>("octet_length", ["event_json"]), "+", 1))
                  .as("bytes"),
              ])
              .groupBy(["session_id", "run_id"]),
          )
          .selectFrom("runs")
          // Match the previous GROUP BY input order for locale-equal strings and NULL/empty IDs.
          .select((eb) =>
            eb.fn
              .agg<number>("openclaw_trajectory_retention", [
                "session_id",
                "run_id",
                "newest",
                "bytes",
              ])
              .orderBy("session_id")
              .orderBy("run_id")
              .as("selected"),
          ),
      ),
    { operationLabel: "trajectory.runtime.retention.select" },
  );
  oldest.sort(compareRuns);
  const cutoff = now - RETENTION_MAX_AGE_MS;
  const maxBytes = Math.max(1, Math.floor(input.maxGlobalRuntimeBytes ?? GLOBAL_MAX_BYTES));
  const eligible = oldest.filter((run) => {
    if (run.newest >= cutoff && totalBytes <= maxBytes) {
      return false;
    }
    totalBytes -= run.bytes;
    return true;
  });
  let batchBytes = 0;
  const runs = eligible.filter((run, index) => {
    batchBytes += run.bytes;
    // Keep the eviction prefix and permit one oversized legacy run without splitting it.
    return index === 0 || batchBytes <= TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES;
  });
  return {
    complete: eligible.length < DELETE_RUN_BATCH_SIZE && runs.length === eligible.length,
    sessionId: input.sessionId,
    runs: runs.map(({ sessionId, runId }) => ({ sessionId, runId })),
  };
}

/** Revalidate the same native generation after writer admission, never compare reader versions. */
export function deleteTrajectoryRuntimeRetention(
  database: OpenClawAgentDatabase,
  plan: TrajectoryRuntimeRetentionPlan,
  revision: TrajectoryRuntimeRetentionRevision,
): { complete: boolean; revision: TrajectoryRuntimeRetentionRevision } | undefined {
  const current = readTrajectoryRuntimeRetentionRevision(database);
  if (
    current.incarnation !== revision.incarnation ||
    current.dataVersion !== revision.dataVersion ||
    current.mutationRevision !== revision.mutationRevision
  ) {
    return undefined;
  }
  const db = getNodeSqliteKysely<RetentionDatabase>(database.db);
  if (plan.runs.length) {
    executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("trajectory_runtime_events")
        .where("session_id", "!=", plan.sessionId)
        .where((eb) =>
          eb.or(
            plan.runs.map((run) =>
              eb.and([
                eb("session_id", "=", run.sessionId),
                run.runId === null ? eb("run_id", "is", null) : eb("run_id", "=", run.runId),
              ]),
            ),
          ),
        ),
    );
  }
  return { complete: plan.complete, revision: readTrajectoryRuntimeRetentionRevision(database) };
}
