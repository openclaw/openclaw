import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readWorkerPreparation } from "../gateway/worker-environments/preparation-identity.schema.js";
import { jsonPathValue, jsonValid } from "../infra/database-engine/json-values.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";

function historicalImageQuery(db: DatabaseSync) {
  return getNodeSqliteKysely<DB>(db)
    .selectFrom("worker_environments")
    .select(["environment_id", "profile_snapshot_json"])
    .where((eb) => eb(jsonValid(db, eb.ref("profile_snapshot_json")), "=", 1))
    .where((eb) =>
      eb(
        jsonPathValue(db, eb.ref("profile_snapshot_json"), eb.val("$.project.kind")),
        "=",
        "image",
      ),
    );
}

export function hasHistoricalImageReserveSnapshots(db: DatabaseSync): boolean {
  return (
    tableExists(db, "worker_environments") &&
    executeSqliteQueryTakeFirstSync(db, historicalImageQuery(db).limit(1)) !== undefined
  );
}

/** Doctor owns this data cutover even when an earlier import already published schema 22. */
export function migrateHistoricalImageReserveSnapshots(db: DatabaseSync): string[] {
  if (!tableExists(db, "worker_environments")) {
    return [];
  }
  const rows = executeSqliteQuerySync(db, historicalImageQuery(db)).rows;
  for (const row of rows) {
    if (typeof row.profile_snapshot_json !== "string" || typeof row.environment_id !== "string") {
      throw new Error("Historical image reserve row is invalid");
    }
    const profile: unknown = JSON.parse(row.profile_snapshot_json);
    const project = isRecord(profile) ? profile.project : undefined;
    if (
      !isRecord(profile) ||
      !isRecord(project) ||
      project.kind !== "image" ||
      typeof project.key !== "string" ||
      !/^[a-f0-9]{64}$/u.test(project.key) ||
      !isRecord(project.preparation) ||
      profile.runtimePreparation !== undefined ||
      profile.historicalProfileSnapshotJson !== undefined
    ) {
      throw new Error("Historical image reserve snapshot has conflicting or invalid preparation");
    }
    // Main models non-repository preparation as empty; the image identity remains archived.
    profile.runtimePreparation = { ...project.preparation, source: "empty" };
    delete profile.project;
    readWorkerPreparation(profile);
    // Retain original serialized evidence, including the retired image-project key.
    // The current profile owners never consume this archive as preparation authority.
    profile.historicalProfileSnapshotJson = row.profile_snapshot_json;
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .updateTable("worker_environments")
        .set({ profile_snapshot_json: JSON.stringify(profile) })
        .where("environment_id", "=", row.environment_id),
    );
  }
  return rows.length > 0
    ? ["Migrated historical image reserves with original snapshot evidence retained"]
    : [];
}
