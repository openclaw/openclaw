import type { DatabaseSync } from "node:sqlite";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { RETIRED_SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX } from "../system-owned-declaration.js";
import {
  deleteCronJobRowInDatabase,
  fingerprintCronJobRows,
  fingerprintCronRuntimeRows,
  loadedCronStoreFromRows,
  loadCronRows,
} from "./row-codec.js";
import {
  loadCronRuntimeAuthorities,
  repairCronRuntimeAuthorityRows,
} from "./runtime-authority-store.js";
import { tryParseJsonObject } from "./scalar-codec.js";
import type { CronJobReadRow } from "./schema.js";
import type { LoadedCronStore } from "./types.js";

type CronLoadWriter = {
  write<T>(operation: (db: DatabaseSync) => T, operationLabel: string): T;
  committed(): void;
};

/** The weekly Workshop curator and its older `skillCollectionReview` payload are retired. */
function isRetiredCollectionReview(row: CronJobReadRow): boolean {
  const job = tryParseJsonObject(row.job_json);
  const declarationKey = row.declaration_key ?? job?.declarationKey;
  return (
    row.payload_kind === "skillCollectionReview" ||
    asRecord(job?.payload).kind === "skillCollectionReview" ||
    (typeof declarationKey === "string" &&
      declarationKey.startsWith(RETIRED_SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX))
  );
}

export function loadCronStoreFromDatabase(
  database: DatabaseSync,
  storeKey: string,
  writer?: CronLoadWriter,
): LoadedCronStore {
  let rows = loadCronRows(database, storeKey);
  const retiredIds = new Set(rows.filter(isRetiredCollectionReview).map((row) => row.job_id));
  if (!writer) {
    // Hide retired jobs before validation; the next mutable load owns durable deletion.
    rows = rows.filter((row) => !retiredIds.has(row.job_id));
  } else if (retiredIds.size > 0) {
    // Retire generated jobs before runtime validation, including databases already
    // on the current schema version. No replacement job is created.
    const removed = writer.write((db) => {
      const current = loadCronRows(db, storeKey, retiredIds).filter(isRetiredCollectionReview);
      for (const row of current) {
        deleteCronJobRowInDatabase(db, storeKey, row.job_id);
      }
      return current.length;
    }, "cron.retire-collection-review");
    if (removed > 0) {
      writer.committed();
    }
    rows = loadCronRows(database, storeKey);
  }
  const loaded = loadedCronStoreFromRows(rows);
  if (rows.length > 0) {
    const authority = loadCronRuntimeAuthorities({
      db: database,
      storeKey,
      jobs: loaded.store.jobs,
    });
    if (writer) {
      repairLoadedCronRuntimeAuthority(writer, {
        storeKey,
        jobIds: authority.repairJobIds,
      });
    }
  }
  return !writer
    ? loaded
    : {
        ...loaded,
        jobsFingerprint: fingerprintCronJobRows(rows),
        runtimeFingerprint: fingerprintCronRuntimeRows(rows),
      };
}

function repairLoadedCronRuntimeAuthority(
  writer: CronLoadWriter,
  params: {
    storeKey: string;
    jobIds: readonly string[];
  },
): void {
  if (params.jobIds.length === 0) {
    return;
  }
  const repaired = writer.write((db) => {
    const rows = loadCronRows(db, params.storeKey, new Set(params.jobIds));
    if (rows.length === 0) {
      return false;
    }
    const loaded = loadedCronStoreFromRows(rows);
    return repairCronRuntimeAuthorityRows({
      db,
      storeKey: params.storeKey,
      jobs: loaded.store.jobs,
      jobIds: params.jobIds,
    });
  }, "cron.runtime-authority-repair");
  if (repaired) {
    writer.committed();
  }
}
