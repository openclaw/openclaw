import type {
  OpenClawStateDatabaseOptions,
  OpenClawStateSchemaReadAdmission,
} from "../state/openclaw-state-db-contract.js";
import { createOpenClawStateCurrentWarmReader } from "../state/openclaw-state-db-current-reader.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
  readCurrentOpenClawStateDatabaseContentVersion,
} from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateReadOptions } from "../state/openclaw-state-read.types.js";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "./kysely-sync.js";
import {
  decodeRun,
  readActiveUpdateRun,
  readUpdateRunRecord,
  readUpdateRuns,
  type UpdateRunListInput,
} from "./update-run-read.kernel.js";
import {
  isAcknowledgedAbandonedUpdateRun,
  type UpdateFetchFailure,
  type UpdateRunRecord,
} from "./update-run-record.js";

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
  return await withArtifactPreservingStateReads(() =>
    readUpdateRunAsync(runId, options, { preferIndependentWarmRead: true }),
  );
}

/** The active updater already writes this ledger, so SQLite sidecars need no private copy.
 * Canonical state closure drains the retained worker before database replacement.
 */
export function getUpdateRunForProgressAsync(
  runId: string,
  options: OpenClawStateDatabaseOptions = {},
  signal?: AbortSignal,
): Promise<UpdateRunRecord | undefined> {
  return readUpdateRunAsync(runId, options, { live: true, signal });
}

async function readUpdateRunAsync(
  runId: string,
  options: OpenClawStateDatabaseOptions,
  readOptions: OpenClawStateReadOptions,
): Promise<UpdateRunRecord | undefined> {
  const reply = await executeExistingOpenClawStateRead(
    options,
    { type: "updateRuns.get", runId },
    readOptions,
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

/** Read current rows on an independent warm owner; cold reads preserve every source byte.
 * The caller still evaluates admission on every invocation; no grant is cached.
 */
export function createUpdateRunAdmissionReader(
  input: UpdateRunListInput,
  options: OpenClawStateDatabaseOptions,
  openStateSchemaReadAdmission: OpenClawStateSchemaReadAdmission,
): () => UpdateRunRecord[] {
  const query = { ...input };
  const readWarm = createOpenClawStateCurrentWarmReader(
    ({ db }) => readUpdateRuns(db, query),
    options,
    openStateSchemaReadAdmission,
  );
  let previous: { version: string; runs: UpdateRunRecord[] } | undefined;
  return () => {
    const warm = readWarm();
    if (warm.available) {
      previous = undefined;
      return warm.value;
    }
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

/** Keep the fixed status projection in one read-worker snapshot. */
export async function getUpdateRunStatusAsync(
  options: OpenClawStateDatabaseOptions = {},
): Promise<{ activeRun?: UpdateRunRecord; lastRun?: UpdateRunRecord }> {
  const reply = await withArtifactPreservingStateReads(() =>
    executeExistingOpenClawStateRead(
      options,
      { type: "updateRuns.status" },
      { preferIndependentWarmRead: true },
    ),
  );
  if (!reply) {
    return {};
  }
  if (!reply.ok || reply.type !== "updateRuns.status") {
    throw new Error("Unexpected update run status result");
  }
  return reply.status;
}

export async function getUpdateRunHistoryStatusAsync(
  options: OpenClawStateDatabaseOptions = {},
): Promise<{
  activeRun?: UpdateRunRecord;
  lastRun?: UpdateRunRecord;
  expiredRun?: UpdateRunRecord;
}> {
  const reply = await withArtifactPreservingStateReads(() =>
    executeExistingOpenClawStateRead(
      options,
      { type: "updateRuns.historyStatus" },
      { preferIndependentWarmRead: true },
    ),
  );
  if (!reply) {
    return {};
  }
  if (!reply.ok || reply.type !== "updateRuns.historyStatus") {
    throw new Error("Unexpected update run history status result");
  }
  return reply.status;
}

/** Doctor retains its maintenance owner while the worker reads the private snapshot. */
export async function listUpdateRunsAsync(
  input: UpdateRunListInput = {},
  options: OpenClawStateDatabaseOptions = {},
): Promise<UpdateRunRecord[]> {
  const reply = await withArtifactPreservingStateReads(() =>
    executeExistingOpenClawStateRead(
      options,
      { type: "updateRuns.list", input: { ...input } },
      { preferIndependentWarmRead: true },
    ),
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
