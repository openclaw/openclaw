/** Database-backed per-job scratch storage, kept outside public cron job state. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { captureCronMutationCommit } from "./mutation-completion.js";
import {
  assertCronJobScratchContent,
  type CronJobScratchState,
  type CronJobScratchWriteResult,
} from "./scratch-contract.js";
import { runCronRuntimeMutation } from "./service/runtime-mutation.js";
import { cronStoreKey } from "./store/key.js";
import { getCronStoreKysely } from "./store/schema.js";

function rowToState(row: {
  content: string | null;
  revision: number;
  source_sha256: string | null;
  updated_at_ms: number;
}): CronJobScratchState {
  if (row.content === null) {
    return { currentRevision: row.revision };
  }
  return {
    currentRevision: row.revision,
    scratch: {
      content: row.content,
      revision: row.revision,
      ...(row.source_sha256 ? { sourceSha256: row.source_sha256 } : {}),
      updatedAtMs: row.updated_at_ms,
    },
  };
}

function readScratchStateFromDatabase(
  db: DatabaseSync,
  storeKey: string,
  jobId: string,
): CronJobScratchState {
  const cronDb = getCronStoreKysely(db);
  const row = executeSqliteQuerySync(
    db,
    cronDb
      .selectFrom("cron_job_scratch")
      .select(["content", "revision", "source_sha256", "updated_at_ms"])
      .where("store_key", "=", storeKey)
      .where("job_id", "=", jobId),
  ).rows[0];
  return row ? rowToState(row) : { currentRevision: 0 };
}

/** Reads one job's scratch state without exposing it through cron list/history surfaces. */
export function readCronJobScratchState(
  storePath: string,
  jobId: string,
  options: OpenClawStateDatabaseOptions = {},
): CronJobScratchState {
  const { db } = openOpenClawStateDatabase(options);
  return readScratchStateFromDatabase(db, cronStoreKey(storePath), jobId);
}

function readHeartbeatMonitorScratchFromDatabase(
  db: DatabaseSync,
  storePath: string,
  agentId: string,
): { jobId: string; state: CronJobScratchState } | undefined {
  const storeKey = cronStoreKey(storePath);
  const cronDb = getCronStoreKysely(db);
  const row = executeSqliteQuerySync(
    db,
    cronDb
      .selectFrom("cron_jobs")
      .leftJoin("cron_job_scratch", (join) =>
        join
          .onRef("cron_job_scratch.store_key", "=", "cron_jobs.store_key")
          .onRef("cron_job_scratch.job_id", "=", "cron_jobs.job_id"),
      )
      .select([
        "cron_jobs.job_id as job_id",
        "cron_job_scratch.content as content",
        "cron_job_scratch.revision as revision",
        "cron_job_scratch.source_sha256 as source_sha256",
        "cron_job_scratch.updated_at_ms as updated_at_ms",
      ])
      .where("cron_jobs.store_key", "=", storeKey)
      .where("cron_jobs.declaration_key", "=", `heartbeat:${agentId}`)
      .where("cron_jobs.payload_kind", "=", "heartbeat"),
  ).rows[0];
  if (!row) {
    return undefined;
  }
  if (row.revision === null || row.updated_at_ms === null) {
    return { jobId: row.job_id, state: { currentRevision: 0 } };
  }
  return {
    jobId: row.job_id,
    state: rowToState({
      content: row.content,
      revision: row.revision,
      source_sha256: row.source_sha256,
      updated_at_ms: row.updated_at_ms,
    }),
  };
}

/** Resolves the current heartbeat monitor and its scratch with one narrow SQLite query. */
export function readHeartbeatMonitorScratch(
  storePath: string,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): { jobId: string; state: CronJobScratchState } | undefined {
  const { db } = openOpenClawStateDatabase(options);
  return readHeartbeatMonitorScratchFromDatabase(db, storePath, agentId);
}

/** Reads heartbeat scratch from existing shared state without creating or migrating it. */
export function readHeartbeatMonitorScratchReadOnly(
  storePath: string,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): { jobId: string; state: CronJobScratchState } | undefined {
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => readHeartbeatMonitorScratchFromDatabase(db, storePath, agentId),
    options,
  );
}

/** Writes through the existing actor while retaining the original caller's admission. */
export async function writeCronJobScratch(
  params: {
    storePath: string;
    jobId: string;
    content: string | null;
    expectedRevision?: number;
    sourceSha256?: string;
    nowMs?: number;
    options?: Pick<OpenClawStateDatabaseOptions, "path" | "env">;
  },
  admission?: {
    context?: OpenClawStateWorkerContext;
    assertCurrent?: () => void;
    assertJobCurrent?: (configRevision: string | undefined) => void;
  },
): Promise<CronJobScratchWriteResult> {
  if (params.content !== null) {
    assertCronJobScratchContent(params.content);
  }
  const context = admission?.context ?? captureOpenClawStateWorkerContext(params.options);
  const markCommitted = captureCronMutationCommit("cron.scratch.set");
  let result: CronJobScratchWriteResult | undefined;
  await runCronRuntimeMutation({
    context,
    type: "cron.writeScratch",
    input: {
      storeKey: cronStoreKey(params.storePath),
      jobId: params.jobId,
      content: params.content,
      expectedRevision: params.expectedRevision,
      sourceSha256: params.sourceSha256,
      nowMs: params.nowMs ?? Date.now(),
    },
    assertCurrent: () => admission?.assertCurrent?.(),
    prepare({ configRevision }) {
      const assertCurrent = () => {
        admission?.assertCurrent?.();
        admission?.assertJobCurrent?.(configRevision);
      };
      assertCurrent();
      return { value: {}, assertCurrent };
    },
    publish(outcome) {
      result = outcome.result;
      if (outcome.written) {
        markCommitted?.();
      }
    },
  });
  if (!result) {
    throw new Error("Cron scratch write has no committed result");
  }
  return result;
}

/**
 * Deletes scratch when its owning job is removed, or — with expectedRevision —
 * atomically reverts a migration write back to the no-row state. Returns false
 * when the guarded revision moved.
 */
export function deleteCronJobScratch(
  storePath: string,
  jobId: string,
  options: OpenClawStateDatabaseOptions = {},
  guard?: { expectedRevision: number },
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const storeKey = cronStoreKey(storePath);
      const cronDb = getCronStoreKysely(db);
      if (guard) {
        const row = executeSqliteQuerySync(
          db,
          cronDb
            .selectFrom("cron_job_scratch")
            .select(["revision", "updated_at_ms"])
            .where("store_key", "=", storeKey)
            .where("job_id", "=", jobId),
        ).rows[0];
        const currentRevision = row?.revision ?? 0;
        if (currentRevision !== guard.expectedRevision) {
          return false;
        }
      }
      executeSqliteQuerySync(
        db,
        cronDb
          .deleteFrom("cron_job_scratch")
          .where("store_key", "=", storeKey)
          .where("job_id", "=", jobId),
      );
      return true;
    },
    options,
    { operationLabel: "cron.scratch.delete" },
  );
}

/** Hash used by doctor to prove the file it removes is the file it migrated. */
export function hashCronScratchSource(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
