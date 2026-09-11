import type { DatabaseSync } from "node:sqlite";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
} from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "./kysely-sync.js";
import { inspectUpdateRunAbandonment } from "./update-run-activity.js";
import { decodeRun } from "./update-run-codec.js";
import { LEGACY_UPDATE_RUN_EXPIRED_REASON } from "./update-run-legacy-expiry.js";
import type { UpdateFetchFailure, UpdateRunRecord } from "./update-run-record.js";
import { hasStoredUpdateRecovery } from "./update-run-recovery-store.js";
import { ABANDONED_UPDATE_RUN_MS } from "./update-run-timeouts.js";

export function readUpdateRunRecord(db: DatabaseSync, runId: string): UpdateRunRecord | undefined {
  const query = getNodeSqliteKysely<Pick<DB, "update_runs">>(db)
    .selectFrom("update_runs")
    .selectAll()
    .where("run_id", "=", runId);
  const row = executeSqliteQueryTakeFirstSync(db, query);
  return row ? decodeRun(row) : undefined;
}

export function getUpdateRun(
  runId: string,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRunRecord | undefined {
  return withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => (tableExists(db, "update_runs") ? readUpdateRunRecord(db, runId) : undefined),
    options,
  );
}

export function findActiveUpdateRun(
  options: OpenClawStateDatabaseOptions = {},
): UpdateRunRecord | undefined {
  return listUpdateRuns({ limit: 1, active: true }, options)[0];
}

export async function getUpdateRunAsync(
  runId: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<UpdateRunRecord | undefined> {
  return await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
    ({ db }) => (tableExists(db, "update_runs") ? readUpdateRunRecord(db, runId) : undefined),
    options,
  );
}

type ListInput = { limit?: number; active?: boolean; reason?: string };

function readRuns(db: DatabaseSync, input: ListInput): UpdateRunRecord[] {
  if (!tableExists(db, "update_runs")) {
    return [];
  }
  let query = getNodeSqliteKysely<Pick<DB, "update_runs">>(db)
    .selectFrom("update_runs")
    .selectAll();
  if (input.active) {
    query = query.where("status", "=", "running");
  }
  if (input.reason) {
    query = query.where("reason", "=", input.reason);
  }
  return executeSqliteQuerySync(
    db,
    query
      .orderBy("created_at_ms", "desc")
      .orderBy("run_id", "desc")
      .limit(Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20)))),
  ).rows.map(decodeRun);
}

export function listUpdateRuns(
  input: ListInput = {},
  options: OpenClawStateDatabaseOptions = {},
): UpdateRunRecord[] {
  return (
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => readRuns(db, input),
      options,
    ) ?? []
  );
}

/** Doctor awaits a private snapshot while its real maintenance owner is retained. */
export async function listUpdateRunsAsync(
  input: ListInput = {},
  options: OpenClawStateDatabaseOptions = {},
): Promise<UpdateRunRecord[]> {
  return (
    (await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
      ({ db }) => readRuns(db, input),
      options,
    )) ?? []
  );
}

/** Only a later recorded fetch completion clears an updater fetch failure. */
export function getLatestUpdateFetchFailure(
  options: OpenClawStateDatabaseOptions = {},
): UpdateFetchFailure | undefined {
  return withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
    if (!tableExists(db, "update_runs")) {
      return undefined;
    }
    const query = getNodeSqliteKysely<Pick<DB, "update_runs">>(db)
      .selectFrom("update_runs")
      .selectAll()
      .orderBy("created_at_ms", "desc")
      .orderBy("run_id", "desc");
    let latestAtMs = -Infinity;
    let latestFailure: UpdateFetchFailure | undefined;
    // Runs can overlap: creation, heartbeats, and finalization do not order fetch outcomes.
    for (const row of iterateSqliteQuerySync(db, query)) {
      const run = decodeRun(row);
      const fetchSteps = run.steps.filter(
        ({ step }) =>
          /^git (?:fetch(?:\s|$)|target inspection fetch$)/u.test(step) ||
          step === "git import admitted target",
      );
      const failed = fetchSteps.findLast((step) => step.status === "failed");
      // A run can complete its branch fetch and then fail fetching tags.
      if (run.reason === "fetch-failed" || failed) {
        const failedAtMs = failed?.endedAtMs ?? run.finishedAtMs ?? run.updatedAtMs;
        if (failedAtMs < latestAtMs) {
          continue;
        }
        const detail = failed?.detail ?? "";
        latestAtMs = failedAtMs;
        latestFailure = {
          reason: "fetch-failed",
          failedAtMs,
          detail: /would clobber existing tag/iu.test(detail)
            ? "tag conflict"
            : /authentication|permission denied|could not read Username|access denied/iu.test(
                  detail,
                )
              ? "authentication failed"
              : /resolve host|network|timed? out|timeout|unreachable/iu.test(detail)
                ? "network error"
                : "fetch-failed",
          runId: run.runId,
        };
      } else {
        for (const step of fetchSteps) {
          // Untimed fetches cannot borrow a timestamp from later build/heartbeat activity.
          if (step.status !== "completed" || step.endedAtMs === undefined) {
            continue;
          }
          const completedAtMs = step.endedAtMs;
          // A same-time completion is not evidence that the failure was superseded.
          if (completedAtMs > latestAtMs) {
            latestAtMs = completedAtMs;
            latestFailure = undefined;
          }
        }
      }
    }
    return latestFailure;
  }, options);
}

export type UpdateRunReconciliationInput = {
  explicit?: boolean;
  runIds?: readonly string[];
  requireAllActive?: boolean;
  legacyOnly?: boolean;
};
export type UpdateRunReconciliationCandidate = {
  record: UpdateRunRecord;
  rule: string | undefined;
};

export function inspectUpdateRunReconciliation(
  db: DatabaseSync,
  record: UpdateRunRecord,
  input: UpdateRunReconciliationInput,
): UpdateRunReconciliationCandidate {
  return {
    record,
    rule: hasStoredUpdateRecovery(db, record.runId)
      ? undefined
      : inspectUpdateRunAbandonment(record, input),
  };
}

export function readUpdateRunReconciliationCandidates(
  db: DatabaseSync,
  input: UpdateRunReconciliationInput,
): UpdateRunReconciliationCandidate[] {
  if (!tableExists(db, "update_runs")) {
    return [];
  }
  let query = getNodeSqliteKysely<Pick<DB, "update_runs">>(db)
    .selectFrom("update_runs")
    .selectAll()
    .where("status", "=", "running");
  if (!input.explicit) {
    query = query.where("updated_at_ms", "<", Date.now() - ABANDONED_UPDATE_RUN_MS);
  }
  if (input.runIds) {
    query = query.where("run_id", "in", [...input.runIds]);
  }
  return executeSqliteQuerySync(db, query.orderBy("run_id")).rows.map((row) =>
    inspectUpdateRunReconciliation(db, decodeRun(row), input),
  );
}

export function canReconcileCandidates(
  candidates: UpdateRunReconciliationCandidate[],
  input: UpdateRunReconciliationInput,
): boolean {
  return (
    candidates.some(
      ({ rule }) => rule && (!input.legacyOnly || rule === LEGACY_UPDATE_RUN_EXPIRED_REASON),
    ) &&
    !(input.explicit && candidates.some(({ record, rule }) => record.status === "running" && !rule))
  );
}
