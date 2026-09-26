import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { createVerifiedSqliteSnapshot } from "../../infra/sqlite-snapshot.js";
import type { PluginDoctorRepairAuthority } from "../../infra/state-migrations.types.js";
import type {
  PluginDoctorCronChange,
  PluginDoctorCronInventory,
  PluginDoctorCronJob,
} from "../../plugins/doctor-contract-module.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { sanitizeOpenClawStateLeaseRows } from "../../state/openclaw-state-snapshot-sanitizer.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { inspectCronRowsForDoctor } from "./doctor-inventory.js";
import { inspectCronJobsReadOnly } from "./read-only.js";
import {
  deleteCronJobRowInDatabase,
  loadCronRows,
  rowToCronJob,
  upsertCronJobRow,
} from "./row-codec.js";

type DoctorCronScope = { env: NodeJS.ProcessEnv };

export async function inspectCronJobsForDoctor(
  scope: DoctorCronScope,
): Promise<PluginDoctorCronInventory> {
  return {
    jobs: await inspectCronJobsReadOnly(scope.env),
  };
}

function definitionEvidence(jobs: readonly PluginDoctorCronJob[]) {
  return jobs.map(({ storeKey, id, sortOrder, definitionJson }) => ({
    storeKey,
    id,
    sortOrder,
    definitionJson,
  }));
}

/** One host-owned repair transaction; plugins choose rows, never database paths or SQL. */
export async function repairCronJobsForDoctor(
  scope: DoctorCronScope,
  authority: PluginDoctorRepairAuthority,
  inspected: PluginDoctorCronInventory,
  requested: readonly PluginDoctorCronChange[],
): Promise<{ changed: number; backupPath?: string }> {
  authority.assertCurrent();
  // Capture the plugin's plan before yielding to backup work.
  const inventory = structuredClone(inspected);
  const changes = structuredClone(requested).filter(
    (change) =>
      change.definition === null || !isDeepStrictEqual(change.job.definition, change.definition),
  );
  if (changes.length === 0) {
    return { changed: 0 };
  }
  const seen = new Set<string>();
  for (const change of changes) {
    const key = JSON.stringify([change.job.storeKey, change.job.id]);
    if (seen.has(key) || !inventory.jobs.some((job) => isDeepStrictEqual(job, change.job))) {
      throw new Error("Cron Doctor repair requires distinct inspected rows.");
    }
    if (change.definition && change.definition.id !== change.job.id) {
      throw new Error("Cron Doctor repair must preserve job IDs.");
    }
    seen.add(key);
  }
  const expected = definitionEvidence(inventory.jobs);
  const assertRowsUnchanged = (db: DatabaseSync) => {
    if (!isDeepStrictEqual(definitionEvidence(inspectCronRowsForDoctor(db)), expected)) {
      throw new Error(
        "Cron definitions changed during Doctor repair; inspect again before retrying.",
      );
    }
  };
  const sourcePath = resolveOpenClawStateSqlitePath(scope.env);
  const backupPath = `${sourcePath}.doctor-cron-${Date.now()}-${randomUUID()}.bak`;
  await createVerifiedSqliteSnapshot({
    sourcePath,
    targetPath: backupPath,
    preserveRowIds: true,
    transform: sanitizeOpenClawStateLeaseRows,
    requireNonEmptySource: true,
    validate: assertRowsUnchanged,
    beforePublish: () => authority.assertCurrent(),
    afterPublish: (guard) => guard.assertTargetUnchanged(() => authority.assertCurrent()),
  });
  try {
    authority.assertCurrent();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        authority.assertOwnedInTransaction(db);
        assertRowsUnchanged(db);
        for (const { job, definition } of changes) {
          if (!definition) {
            deleteCronJobRowInDatabase(db, job.storeKey, job.id);
            continue;
          }
          const row = loadCronRows(db, job.storeKey, new Set([job.id]))[0];
          const replacement = row && rowToCronJob(row, definition);
          if (!replacement) {
            throw new Error(
              `Cron Doctor repair cannot persist job ${job.id}; backup retained at ${backupPath}.`,
            );
          }
          upsertCronJobRow(db, job.storeKey, replacement, job.sortOrder, {
            preserveRuntimeState: true,
          });
        }
        for (const storeKey of new Set(changes.map(({ job }) => job.storeKey))) {
          deferSqlitePostCommitPublication(db, () => noteCronJobsStoreCommit(storeKey));
        }
      },
      { env: scope.env },
      { operationLabel: "cron.doctor-repair" },
    );
  } catch (error) {
    throw new Error(
      `Cron Doctor repair failed; verified backup retained at ${backupPath}: ${String(error)}`,
      { cause: error },
    );
  }
  return { changed: changes.length, backupPath };
}
