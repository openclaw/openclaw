import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { cronStoreKey } from "./key.js";
import {
  materializeCronJobsStoreOwners,
  mergePreparedCronOwnerRollbacks,
  rollbackMaterializedCronJobsStoreOwners,
  type PreparedCronOwnerRollback,
} from "./owner-migration.js";
import {
  loadCronRows,
  readCronStoreEpoch,
  replaceCronRows,
  upsertCronJobRow,
} from "./row-codec.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(prefix: string) {
  const root = tempDirs.make(prefix);
  const env = { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv;
  const storePath = path.join(root, "cron", "jobs.json");
  return {
    env,
    storePath,
    storeKey: cronStoreKey(path.resolve(storePath)),
    handle: openOpenClawStateDatabase({ env }),
  };
}

function requireRollback(
  rollback: PreparedCronOwnerRollback | undefined,
): PreparedCronOwnerRollback {
  if (!rollback) {
    throw new Error("missing transaction-owned rollback fixture");
  }
  return rollback;
}

describe("cron owner migration rollback", () => {
  it("restores exact rows without deleting a late imported-id writer", async () => {
    const { env, storePath, storeKey, handle } = fixture("openclaw-cron-owner-rollback-");
    const baseline = makeCronJob({ id: "baseline" });
    const lateImportedId = makeCronJob({ id: "legacy-import" });
    const lateOwnerless = makeCronJob({ id: "late-ownerless" });
    try {
      replaceCronRows(
        handle.db,
        storeKey,
        { version: 1, jobs: [baseline] },
        { bumpStoreEpoch: true },
      );
      const loadedEpoch = readCronStoreEpoch(handle.db, storeKey);
      upsertCronJobRow(handle.db, storeKey, lateImportedId, 1);
      upsertCronJobRow(handle.db, storeKey, lateOwnerless, 2);
      handle.db
        .prepare("UPDATE cron_store_epochs SET store_epoch = ? WHERE store_key = ?")
        .run(loadedEpoch, storeKey);
      const rowsBefore = loadCronRows(handle.db, storeKey);
      let rollback: PreparedCronOwnerRollback | undefined;

      await materializeCronJobsStoreOwners({
        storePath,
        legacyDefaultAgentId: "ops",
        records: [baseline, lateImportedId],
        legacyImportedJobIds: new Set([lateImportedId.id]),
        expectedStoreEpoch: loadedEpoch,
        recordPreparedRollback: (prepared) => {
          rollback = prepared;
        },
        env,
      });
      expect(loadCronRows(handle.db, storeKey).map((row) => row.agent_id)).toEqual([
        "ops",
        "ops",
        "ops",
      ]);
      const prepared = requireRollback(rollback);

      await rollbackMaterializedCronJobsStoreOwners({ rollback: prepared, env });

      expect(loadCronRows(handle.db, storeKey)).toEqual(rowsBefore);
      expect(readCronStoreEpoch(handle.db, storeKey)).toBeGreaterThan(prepared.expectedStoreEpoch);
    } finally {
      handle.walMaintenance.close();
      handle.db.close();
    }
  });

  it("preserves an epoch-blind edit between consecutive handoff transactions", async () => {
    const { env, storePath, storeKey, handle } = fixture("openclaw-cron-owner-compose-");
    const original = makeCronJob({ id: "composed" });
    try {
      replaceCronRows(
        handle.db,
        storeKey,
        { version: 1, jobs: [original] },
        { bumpStoreEpoch: true },
      );
      let first: PreparedCronOwnerRollback | undefined;
      await materializeCronJobsStoreOwners({
        storePath,
        legacyDefaultAgentId: "ops",
        records: [original],
        legacyImportedJobIds: new Set(),
        recordPreparedRollback: (prepared) => {
          first = prepared;
        },
        env,
      });
      const firstPrepared = requireRollback(first);
      const ownerBearing = loadCronRows(handle.db, storeKey)[0]!;
      const editedJob = { ...JSON.parse(ownerBearing.job_json), name: "late writer edit" };
      handle.db
        .prepare("UPDATE cron_jobs SET name = ?, job_json = ? WHERE store_key = ? AND job_id = ?")
        .run("late writer edit", JSON.stringify(editedJob), storeKey, original.id);
      handle.db
        .prepare("UPDATE cron_store_epochs SET store_epoch = ? WHERE store_key = ?")
        .run(firstPrepared.expectedStoreEpoch, storeKey);
      let second: PreparedCronOwnerRollback | undefined;
      await materializeCronJobsStoreOwners({
        storePath,
        legacyDefaultAgentId: "ops",
        records: [original],
        legacyImportedJobIds: new Set(),
        expectedStoreEpoch: firstPrepared.expectedStoreEpoch,
        recordPreparedRollback: (prepared) => {
          second = prepared;
        },
        env,
      });

      await rollbackMaterializedCronJobsStoreOwners({
        rollback: mergePreparedCronOwnerRollbacks(firstPrepared, requireRollback(second)),
        env,
      });

      const restored = loadCronRows(handle.db, storeKey)[0]!;
      expect(restored.agent_id).toBeNull();
      expect(restored.name).toBe("late writer edit");
      expect(JSON.parse(restored.job_json)).toMatchObject({ name: "late writer edit" });
      expect(JSON.parse(restored.job_json)).not.toHaveProperty("agentId");
    } finally {
      handle.walMaintenance.close();
      handle.db.close();
    }
  });

  it("reports metadata acquisition even when there are no imported job ids", async () => {
    const { env, storePath, handle } = fixture("openclaw-cron-owner-metadata-");
    let recorded = false;

    try {
      await materializeCronJobsStoreOwners({
        storePath,
        legacyDefaultAgentId: "ops",
        records: [],
        legacyImportedJobIds: new Set(),
        acquireMetadata: () => true,
        recordMetadataAcquired: () => {
          recorded = true;
        },
        env,
      });

      expect(recorded).toBe(true);
    } finally {
      handle.walMaintenance.close();
      handle.db.close();
    }
  });

  it("does not delete a transaction-created row edited by an epoch-blind writer", async () => {
    const { env, storePath, storeKey, handle } = fixture("openclaw-cron-owner-insert-compose-");
    const imported = makeCronJob({ id: "imported" });
    try {
      let first: PreparedCronOwnerRollback | undefined;
      await materializeCronJobsStoreOwners({
        storePath,
        legacyDefaultAgentId: "ops",
        records: [imported],
        legacyImportedJobIds: new Set([imported.id]),
        recordPreparedRollback: (prepared) => {
          first = prepared;
        },
        env,
      });
      const firstPrepared = requireRollback(first);
      const row = loadCronRows(handle.db, storeKey)[0]!;
      const editedJob = { ...JSON.parse(row.job_json), name: "independent edit" };
      handle.db
        .prepare("UPDATE cron_jobs SET name = ?, job_json = ? WHERE store_key = ? AND job_id = ?")
        .run("independent edit", JSON.stringify(editedJob), storeKey, imported.id);
      handle.db
        .prepare("UPDATE cron_store_epochs SET store_epoch = ? WHERE store_key = ?")
        .run(firstPrepared.expectedStoreEpoch, storeKey);
      let second: PreparedCronOwnerRollback | undefined;
      await materializeCronJobsStoreOwners({
        storePath,
        legacyDefaultAgentId: "ops",
        records: [imported],
        legacyImportedJobIds: new Set([imported.id]),
        expectedStoreEpoch: firstPrepared.expectedStoreEpoch,
        recordPreparedRollback: (prepared) => {
          second = prepared;
        },
        env,
      });

      await rollbackMaterializedCronJobsStoreOwners({
        rollback: mergePreparedCronOwnerRollbacks(firstPrepared, requireRollback(second)),
        env,
      });

      expect(loadCronRows(handle.db, storeKey)[0]).toMatchObject({
        job_id: imported.id,
        name: "independent edit",
      });
    } finally {
      handle.walMaintenance.close();
      handle.db.close();
    }
  });

  it("preserves a deletion observed by the later handoff transaction", async () => {
    const { env, storePath, storeKey, handle } = fixture("openclaw-cron-owner-delete-compose-");
    const original = makeCronJob({ id: "deleted-between-handoffs" });
    try {
      replaceCronRows(
        handle.db,
        storeKey,
        { version: 1, jobs: [original] },
        { bumpStoreEpoch: true },
      );
      let first: PreparedCronOwnerRollback | undefined;
      await materializeCronJobsStoreOwners({
        storePath,
        legacyDefaultAgentId: "ops",
        records: [original],
        legacyImportedJobIds: new Set(),
        recordPreparedRollback: (prepared) => {
          first = prepared;
        },
        env,
      });
      const firstPrepared = requireRollback(first);
      handle.db
        .prepare("DELETE FROM cron_jobs WHERE store_key = ? AND job_id = ?")
        .run(storeKey, original.id);
      handle.db
        .prepare("UPDATE cron_store_epochs SET store_epoch = ? WHERE store_key = ?")
        .run(firstPrepared.expectedStoreEpoch, storeKey);
      let second: PreparedCronOwnerRollback | undefined;
      await materializeCronJobsStoreOwners({
        storePath,
        legacyDefaultAgentId: "ops",
        records: [],
        legacyImportedJobIds: new Set(),
        expectedStoreEpoch: firstPrepared.expectedStoreEpoch,
        recordPreparedRollback: (prepared) => {
          second = prepared;
        },
        env,
      });

      await rollbackMaterializedCronJobsStoreOwners({
        rollback: mergePreparedCronOwnerRollbacks(firstPrepared, requireRollback(second)),
        env,
      });

      expect(loadCronRows(handle.db, storeKey)).toEqual([]);
    } finally {
      handle.walMaintenance.close();
      handle.db.close();
    }
  });
});
