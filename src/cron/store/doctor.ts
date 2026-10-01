import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { createVerifiedSqliteSnapshot } from "../../infra/sqlite-snapshot.js";
import type { PluginDoctorRepairAuthority } from "../../infra/state-migrations.types.js";
import type {
  PluginDoctorCronChange,
  PluginDoctorCronInventory,
  PluginDoctorCronJob,
} from "../../plugins/doctor-contract-module.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { sanitizeOpenClawStateLeaseRows } from "../../state/openclaw-state-snapshot-sanitizer.js";
import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { inspectCronOwnerRowsForDoctor, inspectCronRowsForDoctor } from "./doctor-inventory.js";
import { cronStoreKey } from "./key.js";
import { inspectCronJobsReadOnly } from "./read-only.js";
import {
  deleteCronJobRowInDatabase,
  loadCronRows,
  resolveCronJobGrantDefinitionGenerationFloor,
  rowToCronJob,
  upsertCronJobRow,
} from "./row-codec.js";
import { tryParseJsonObject } from "./scalar-codec.js";
import { getCronStoreKysely } from "./schema.js";

type DoctorCronScope = { env: NodeJS.ProcessEnv };

export async function inspectCronJobOwnersForDoctor(scope: DoctorCronScope, storePath: string) {
  return (
    (await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
      ({ db }) => inspectCronOwnerRowsForDoctor(db, cronStoreKey(storePath)),
      scope,
    )) ?? []
  );
}

/** Pins only ownerless definitions, retaining every other authored and runtime field. */
export async function repairLegacyCronJobOwnersForDoctor(
  scope: DoctorCronScope,
  authority: PluginDoctorRepairAuthority,
  storePath: string,
  legacyDefaultAgentId: string,
): Promise<{ changed: number; backupPath?: string }> {
  authority.assertCurrent();
  const rows = await inspectCronJobOwnersForDoctor(scope, storePath);
  authority.assertCurrent();
  const legacyAgentId = normalizeAgentId(legacyDefaultAgentId);
  const changes: Array<{ jobId: string; agentId: string; definition: string }> = [];
  for (const row of rows) {
    const job = tryParseJsonObject(row.job_json);
    if (
      tryResolveCronJobEffectiveAgentId({
        agentId: normalizeOptionalString(job?.agentId),
        sessionKey: normalizeOptionalString(job?.sessionKey),
      })
    ) {
      continue;
    }
    if (!job) {
      throw new Error(
        `Cannot verify ownership of malformed cron job ${row.job_id}; repair its stored definition before retiring the legacy owner.`,
      );
    }
    const agentId = normalizeOptionalString(row.agent_id) ?? legacyAgentId;
    changes.push({ jobId: row.job_id, agentId, definition: JSON.stringify({ ...job, agentId }) });
  }
  if (changes.length === 0) {
    return { changed: 0 };
  }
  const storeKey = cronStoreKey(storePath);
  const backupPath = await commitCronDoctorRepair(scope, authority, {
    assertRowsUnchanged(db) {
      if (!isDeepStrictEqual(inspectCronOwnerRowsForDoctor(db, storeKey), rows)) {
        throw new Error(
          "Cron ownership changed during Doctor repair; inspect again before retrying.",
        );
      }
    },
    write(db) {
      for (const change of changes) {
        const retainedGenerationFloor = resolveCronJobGrantDefinitionGenerationFloor(
          db,
          change.jobId,
        );
        executeSqliteQuerySync(
          db,
          getCronStoreKysely(db)
            .updateTable("cron_jobs")
            .set((eb) => ({
              agent_id: change.agentId,
              job_json: change.definition,
              grant_definition_revision: null,
              grant_definition_generation: eb.fn<number>("max", [
                eb(eb.fn.coalesce("grant_definition_generation", eb.val(0)), "+", 1),
                eb.val(retainedGenerationFloor),
              ]),
              grant_definition_updated_at: null,
            }))
            .where("store_key", "=", storeKey)
            .where("job_id", "=", change.jobId),
        );
      }
      deferSqlitePostCommitPublication(db, () => noteCronJobsStoreCommit(storeKey));
    },
  });
  return { changed: changes.length, backupPath };
}

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
  const backupPath = await commitCronDoctorRepair(scope, authority, {
    assertRowsUnchanged,
    write(db) {
      for (const { job, definition } of changes) {
        if (!definition) {
          deleteCronJobRowInDatabase(db, job.storeKey, job.id);
          continue;
        }
        const row = loadCronRows(db, job.storeKey, new Set([job.id]))[0];
        const replacement = row && rowToCronJob(row, definition);
        if (!replacement) {
          throw new Error(`Cron Doctor repair cannot persist job ${job.id}.`);
        }
        upsertCronJobRow(db, job.storeKey, replacement, job.sortOrder, {
          preserveRuntimeState: true,
        });
      }
      for (const storeKey of new Set(changes.map(({ job }) => job.storeKey))) {
        deferSqlitePostCommitPublication(db, () => noteCronJobsStoreCommit(storeKey));
      }
    },
  });
  return { changed: changes.length, backupPath };
}

/** Shared pre-mutation backup for core and plugin cron repairs. */
export async function backupCronStoreForDoctor(
  scope: DoctorCronScope,
  repair: {
    assertCurrent: () => void;
    assertRowsUnchanged: (db: DatabaseSync) => void;
  },
): Promise<string> {
  repair.assertCurrent();
  const sourcePath = resolveOpenClawStateSqlitePath(scope.env);
  const backupPath = `${sourcePath}.doctor-cron-${Date.now()}-${randomUUID()}.bak`;
  await createVerifiedSqliteSnapshot({
    sourcePath,
    targetPath: backupPath,
    preserveRowIds: true,
    transform: sanitizeOpenClawStateLeaseRows,
    requireNonEmptySource: true,
    validate: repair.assertRowsUnchanged,
    beforePublish: repair.assertCurrent,
    afterPublish: (guard) => guard.assertTargetUnchanged(repair.assertCurrent),
  });
  return backupPath;
}

async function commitCronDoctorRepair(
  scope: DoctorCronScope,
  authority: PluginDoctorRepairAuthority,
  repair: {
    assertRowsUnchanged: (db: DatabaseSync) => void;
    write: (db: DatabaseSync) => void;
  },
): Promise<string> {
  const backupPath = await backupCronStoreForDoctor(scope, {
    assertCurrent: () => authority.assertCurrent(),
    assertRowsUnchanged: repair.assertRowsUnchanged,
  });
  try {
    authority.assertCurrent();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        authority.assertOwnedInTransaction(db);
        repair.assertRowsUnchanged(db);
        repair.write(db);
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
  return backupPath;
}
