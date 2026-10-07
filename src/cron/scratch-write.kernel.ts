import type { DatabaseSync } from "node:sqlite";
import {
  createSqliteQueryCache,
  executeSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../infra/kysely-sync.js";
import {
  assertCronJobScratchContent,
  type CronJobScratchWriteInput,
  type CronJobScratchWriteOutcome,
} from "./scratch-contract.js";
import { getCronStoreKysely } from "./store/schema.js";

type ScratchWriteKey = { storeKey: string; jobId: string };
type ScratchWriteGuard = {
  revision: number | null;
  updated_at_ms: number | null;
  job_id: string | null;
};

function prepareScratchWriteGuard(db: DatabaseSync) {
  const cronDb = getCronStoreKysely(db);
  return prepareSqliteQueryTakeFirstSync<ScratchWriteKey, ScratchWriteGuard>(db, (parameter) =>
    cronDb
      // The singleton preserves orphan revisions and the no-scratch state.
      .selectFrom(cronDb.selectNoFrom((eb) => eb.lit(1).as("one")).as("current"))
      .leftJoin("cron_job_scratch as scratch", (join) =>
        join
          .on(
            "scratch.store_key",
            "=",
            parameter((key) => key.storeKey),
          )
          .on(
            "scratch.job_id",
            "=",
            parameter((key) => key.jobId),
          ),
      )
      .leftJoin("cron_jobs as job", (join) =>
        join
          .on(
            "job.store_key",
            "=",
            parameter((key) => key.storeKey),
          )
          .on(
            "job.job_id",
            "=",
            parameter((key) => key.jobId),
          ),
      )
      // Decoding the timestamp preserves refusal of out-of-range stored integers.
      .select(["scratch.revision", "scratch.updated_at_ms", "job.job_id"]),
  );
}

const scratchWriteGuard = createSqliteQueryCache(prepareScratchWriteGuard);

/** Job existence and scratch revision remain one authoritative transaction boundary. */
export function writeCronJobScratchInDatabase(
  db: DatabaseSync,
  input: CronJobScratchWriteInput,
): CronJobScratchWriteOutcome {
  if (input.content !== null) {
    assertCronJobScratchContent(input.content);
  }
  const cronDb = getCronStoreKysely(db);
  const current = scratchWriteGuard(db)(input);
  const currentRevision = current?.revision ?? 0;
  if (
    current?.job_id == null ||
    (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision)
  ) {
    return {
      result: { ok: false, reason: "revision-conflict", currentRevision },
      written: false,
    };
  }
  if (input.content === null && currentRevision === 0) {
    return { result: { ok: true, currentRevision }, written: false };
  }
  const revision = currentRevision + 1;
  const sourceSha256 = input.content !== null ? input.sourceSha256?.trim() : undefined;
  if (currentRevision > 0) {
    executeSqliteQuerySync(
      db,
      cronDb
        .deleteFrom("cron_job_scratch")
        .where("store_key", "=", input.storeKey)
        .where("job_id", "=", input.jobId),
    );
  }
  executeSqliteQuerySync(
    db,
    cronDb.insertInto("cron_job_scratch").values({
      store_key: input.storeKey,
      job_id: input.jobId,
      content: input.content,
      revision,
      ...(sourceSha256 ? { source_sha256: sourceSha256 } : {}),
      updated_at_ms: input.nowMs,
    }),
  );
  return {
    written: true,
    result: {
      ok: true,
      currentRevision: revision,
      ...(input.content !== null
        ? {
            scratch: {
              content: input.content,
              revision,
              ...(sourceSha256 ? { sourceSha256 } : {}),
              updatedAtMs: input.nowMs,
            },
          }
        : {}),
    },
  };
}
