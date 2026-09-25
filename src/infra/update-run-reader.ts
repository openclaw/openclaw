import type { DatabaseSync } from "node:sqlite";
import type {
  OpenClawStateDatabaseOptions,
  OpenClawStateSchemaReadAdmission,
} from "../state/openclaw-state-db-contract.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
  readCurrentOpenClawStateDatabaseContentVersion,
} from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "./kysely-sync.js";
import { inspectUpdateRunAbandonment } from "./update-run-activity.js";
import {
  decodeRun,
  hasStoredUpdateRecovery,
  readActiveUpdateRun,
  readLatestUpdateRun,
  readUpdateRunRecord,
  readUpdateRuns,
  type UpdateRunListInput,
} from "./update-run-read.kernel.js";
import {
  isAcknowledgedAbandonedUpdateRun,
  type UpdateFetchFailure,
  type UpdateRunRecord,
} from "./update-run-record.js";
import { ABANDONED_UPDATE_RUN_MS } from "./update-run-timeouts.js";

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
  return withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => readActiveUpdateRun(db),
    options,
  );
}

/** Previews and acknowledged abandonment cannot replace failure or completion evidence. */
export function readUpdateRunResolutionHistory(options: OpenClawStateDatabaseOptions = {}): {
  failure?: UpdateRunRecord;
  outcome?: UpdateRunRecord;
} {
  return (
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
      if (!tableExists(db, "update_runs")) {
        return {};
      }
      const latest = (failedOnly: boolean) => {
        const query = getNodeSqliteKysely<Pick<DB, "update_runs">>(db)
          .selectFrom("update_runs")
          .selectAll()
          .where("status", failedOnly ? "=" : "!=", failedOnly ? "failed" : "skipped")
          .orderBy("created_at_ms", "desc")
          .orderBy("run_id", "desc");
        for (const row of iterateSqliteQuerySync(db, query)) {
          const run = decodeRun(row);
          if (!isAcknowledgedAbandonedUpdateRun(run)) {
            return run;
          }
        }
        return undefined;
      };
      return { failure: latest(true), outcome: latest(false) };
    }, options) ?? {}
  );
}

export async function getUpdateRunAsync(
  runId: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<UpdateRunRecord | undefined> {
  const reply = await withArtifactPreservingStateReads(() =>
    executeExistingOpenClawStateRead(options, { type: "updateRuns.get", runId }),
  );
  if (!reply) {
    return undefined;
  }
  if (!reply.ok || reply.type !== "updateRuns.get") {
    throw new Error("Unexpected update run lookup result");
  }
  return reply.run;
}

export function listUpdateRuns(
  input: UpdateRunListInput = {},
  options: OpenClawStateDatabaseOptions = {},
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission,
): UpdateRunRecord[] {
  return (
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => readUpdateRuns(db, input),
      options,
      openStateSchemaReadAdmission,
    ) ?? []
  );
}

/** Reuse decoded rows only after a fresh observation of every authoritative source byte.
 * The caller still evaluates admission on every invocation; no grant is cached.
 * This closure owns only rows, never a native handle, child, or temporary snapshot.
 */
export function createUpdateRunAdmissionReader(
  input: UpdateRunListInput,
  options: OpenClawStateDatabaseOptions,
  openStateSchemaReadAdmission: OpenClawStateSchemaReadAdmission,
): () => UpdateRunRecord[] {
  const query = { ...input };
  let previous: { version: string; runs: UpdateRunRecord[] } | undefined;
  return () => {
    const version = readCurrentOpenClawStateDatabaseContentVersion(options);
    if (version !== undefined && previous?.version === version) {
      return structuredClone(previous.runs);
    }
    previous = undefined;
    const runs = listUpdateRuns(query, options, openStateSchemaReadAdmission);
    if (
      version !== undefined &&
      version === readCurrentOpenClawStateDatabaseContentVersion(options)
    ) {
      previous = { version, runs: structuredClone(runs) };
    }
    return runs;
  };
}

/** The fixed two-row status projection reuses the live owner; cold reads prepare one snapshot. */
export async function getUpdateRunStatusAsync(
  options: OpenClawStateDatabaseOptions = {},
): Promise<{ activeRun?: UpdateRunRecord; lastRun?: UpdateRunRecord }> {
  return (
    (await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
      ({ db }) => ({ activeRun: readActiveUpdateRun(db), lastRun: readLatestUpdateRun(db) }),
      options,
    )) ?? {}
  );
}

/** Doctor retains its maintenance owner while the worker reads the private snapshot. */
export async function listUpdateRunsAsync(
  input: UpdateRunListInput = {},
  options: OpenClawStateDatabaseOptions = {},
): Promise<UpdateRunRecord[]> {
  const reply = await withArtifactPreservingStateReads(() =>
    executeExistingOpenClawStateRead(options, { type: "updateRuns.list", input: { ...input } }),
  );
  if (!reply) {
    return [];
  }
  if (!reply.ok || reply.type !== "updateRuns.list") {
    throw new Error("Unexpected update run list result");
  }
  return reply.runs;
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
