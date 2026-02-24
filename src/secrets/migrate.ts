import { applyMigrationPlan } from "./migrate/apply.js";
import {
  listSecretsMigrationBackups,
  readBackupManifest,
  resolveSecretsMigrationBackupRoot,
  restoreFromManifest,
} from "./migrate/backup.js";
import { buildMigrationPlan } from "./migrate/plan.js";
import type {
  SecretsMigrationRollbackOptions,
  SecretsMigrationRollbackResult,
  SecretsMigrationRunOptions,
  SecretsMigrationRunResult,
} from "./migrate/types.js";

export type {
  SecretsMigrationRollbackOptions,
  SecretsMigrationRollbackResult,
  SecretsMigrationRunOptions,
  SecretsMigrationRunResult,
};

export async function runSecretsMigration(
  options: SecretsMigrationRunOptions = {},
): Promise<SecretsMigrationRunResult> {
  const env = options.env ?? process.env;
  const scrubEnv = options.scrubEnv ?? true;
  const plan = await buildMigrationPlan({ env, scrubEnv });

  if (!options.write) {
    return {
      mode: "dry-run",
      changed: plan.changed,
      secretsFilePath: plan.secretsFilePath,
      counters: plan.counters,
      changedFiles: plan.backupTargets,
    };
  }

  return await applyMigrationPlan({
    plan,
    env,
    now: options.now ?? new Date(),
  });
}

export { resolveSecretsMigrationBackupRoot, listSecretsMigrationBackups };

export async function rollbackSecretsMigration(
  options: SecretsMigrationRollbackOptions,
): Promise<SecretsMigrationRollbackResult> {
  const env = options.env ?? process.env;
  const manifest = readBackupManifest({
    backupId: options.backupId,
    env,
  });
  const restored = restoreFromManifest(manifest);
  return {
    backupId: options.backupId,
    restoredFiles: restored.restoredFiles,
    deletedFiles: restored.deletedFiles,
  };
}
