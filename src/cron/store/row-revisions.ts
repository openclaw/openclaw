import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { ensureCronStoreEpochSchema, getCronStoreKysely } from "./schema.js";

function cronRuntimeRevisionKey(storeKey: string): string {
  // Cron store keys are absolute paths, so this non-path namespace cannot collide with a store.
  return `runtime-revision:${storeKey}`;
}

/** Current full-store topology revision for one cron partition. */
export function readCronStoreEpoch(
  db: DatabaseSync,
  storeKey: string,
  options?: { ensureSchema?: boolean },
): number {
  if (options?.ensureSchema !== false) {
    ensureCronStoreEpochSchema(db);
  }
  return (
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .selectFrom("cron_store_epochs")
        .select("store_epoch")
        .where("store_key", "=", storeKey)
        .limit(1),
    ).rows[0]?.store_epoch ?? 0
  );
}

/** Current runtime-only revision for one cron partition. */
export function readCronRuntimeRevision(
  db: DatabaseSync,
  storeKey: string,
  options?: { ensureSchema?: boolean },
): number {
  return readCronStoreEpoch(db, cronRuntimeRevisionKey(storeKey), options);
}

export function writeCronStoreEpoch(db: DatabaseSync, storeKey: string, storeEpoch: number): void {
  ensureCronStoreEpochSchema(db);
  executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .insertInto("cron_store_epochs")
      .values({ store_key: storeKey, store_epoch: storeEpoch })
      .onConflict((conflict) =>
        conflict.column("store_key").doUpdateSet({ store_epoch: storeEpoch }),
      ),
  );
}

/** Advances the topology epoch for one cron store partition. */
export function incrementCronStoreEpoch(db: DatabaseSync, storeKey: string): number {
  ensureCronStoreEpochSchema(db);
  executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .insertInto("cron_store_epochs")
      .values({ store_key: storeKey, store_epoch: 0 })
      .onConflict((conflict) => conflict.column("store_key").doNothing()),
  );
  const row = executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .updateTable("cron_store_epochs")
      .set((eb) => ({ store_epoch: eb("store_epoch", "+", 1) }))
      .where("store_key", "=", storeKey)
      .returning("store_epoch"),
  ).rows[0];
  if (!row) {
    throw new Error(`failed to advance cron store epoch for ${storeKey}`);
  }
  return row.store_epoch;
}

export function incrementCronRuntimeRevision(db: DatabaseSync, storeKey: string): number {
  return incrementCronStoreEpoch(db, cronRuntimeRevisionKey(storeKey));
}

export class CronStoreEpochMismatchError extends Error {
  readonly expectedEpoch: number;
  readonly actualEpoch: number;

  constructor(expectedEpoch: number, actualEpoch: number) {
    super(`cron store epoch changed from ${expectedEpoch} to ${actualEpoch}`);
    this.name = "CronStoreEpochMismatchError";
    this.expectedEpoch = expectedEpoch;
    this.actualEpoch = actualEpoch;
  }
}

export class CronRuntimeRevisionMismatchError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`cron runtime revision changed from ${expectedRevision} to ${actualRevision}`);
    this.name = "CronRuntimeRevisionMismatchError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class CronStoreTopologyMismatchError extends Error {
  constructor() {
    super("cron store topology changed without advancing its epoch");
    this.name = "CronStoreTopologyMismatchError";
  }
}
