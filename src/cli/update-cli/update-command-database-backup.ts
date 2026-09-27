import { resolveStateDir } from "../../config/paths.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  acquireGatewayMaintenanceCoordinator,
  hasGatewayLifecycleCoordinator,
} from "../../infra/state-database-coordinator.js";
import {
  createUpdateDatabaseBackup,
  type UpdateDatabaseBackup,
} from "../../infra/update-database-backup.js";
import { restoreUpdateDatabaseBackup } from "../../infra/update-database-restore.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import {
  readUpdateCandidateSource,
  type OwnedManagedUpdateContext,
} from "./update-command-managed-context.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

type Progress = MutableUpdateExecutionParams["progress"];

export async function captureUpdateDatabases(params: {
  backupRoot: string;
  execution: MutableUpdateExecutionParams;
  context: OwnedManagedUpdateContext | undefined;
  assertCurrent: () => void;
}) {
  const startedAt = Date.now();
  const { execution, context } = params;
  const env = context?.env ?? execution.opts.run!.env;
  params.assertCurrent();
  const source = await readUpdateCandidateSource(env, execution.legacyConfigPlan);
  params.assertCurrent();
  const coordinator = { databasePath: resolveOpenClawStateSqlitePath(env), busyTimeoutMs: 0 };
  let maintenance: ReturnType<typeof acquireGatewayMaintenanceCoordinator> | undefined;
  let unavailable: string | undefined;
  try {
    if (hasGatewayLifecycleCoordinator(coordinator)) {
      throw new Error("This process still owns a running Gateway");
    }
    maintenance = acquireGatewayMaintenanceCoordinator(coordinator);
  } catch (error) {
    unavailable = formatErrorMessage(error);
  }
  let backup: UpdateDatabaseBackup;
  try {
    backup = await createUpdateDatabaseBackup({
      backupRoot: params.backupRoot,
      stateDir: resolveStateDir(env),
      config: source.config,
      env,
      timeoutMs: execution.updateStepTimeoutMs,
      nodeRunner: execution.packageUpdateNodeRunner,
    });
  } finally {
    maintenance?.release();
  }
  params.assertCurrent();
  const restorable =
    maintenance !== undefined &&
    backup.databases.every((entry) => typeof backup.sourceGenerations[entry.path] === "string");
  if (!restorable) {
    backup.warnings.push(
      `Automatic database restoration is disabled because ${unavailable ? `the Gateway could not be confirmed stopped during capture: ${unavailable}` : "a source database changed or its write generation could not be captured"}. Snapshots remain available at ${backup.directory}; later writes must be preserved.`,
    );
  }
  const step: UpdateStepResult = {
    name: "database snapshot",
    command: "snapshot databases before migrations",
    cwd: resolveStateDir(env),
    durationMs: Date.now() - startedAt,
    exitCode: 0,
    diagnostics: [
      `Databases snapshotted at ${backup.directory}. Retain this directory with the update's recovery artifacts.`,
      ...backup.databases.map(
        (entry) =>
          `${entry.path} -> ${entry.snapshotPath}; schema ${entry.userVersion}; ${entry.sizeBytes} bytes; SHA-256 ${entry.sha256}`,
      ),
    ],
    warnings: backup.warnings,
  };
  execution.progress?.onStepComplete?.({ ...step, index: 0, total: 0 });
  return { backup: restorable ? backup : undefined, step };
}

/** Called only before this update admits a candidate Gateway, after its child has settled. */
export async function restoreFailedUpdateDatabases(params: {
  backup: UpdateDatabaseBackup;
  result: UpdateRunResult;
  runId: string;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
  progress?: Progress;
}): Promise<boolean> {
  const startedAt = Date.now();
  const refuse = (reason: string) => {
    params.backup.restoreRefusal ??= reason;
    params.result.reason = "state-migrated-no-rollback";
    const step: UpdateStepResult = {
      name: "database rollback",
      command: "preserve databases changed after snapshot capture",
      cwd: params.backup.directory,
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      stderrTail: `${reason}. Current databases were preserved. Keep the retained snapshots at ${params.backup.directory}; run openclaw doctor from the candidate version to inspect recovery before restarting or downgrading.`,
    };
    params.result.steps.push(step);
    params.progress?.onStepComplete?.({ ...step, index: 0, total: 0 });
    return false;
  };
  if (params.backup.restoreRefusal) {
    return refuse(params.backup.restoreRefusal);
  }
  try {
    const migratedPaths = await restoreUpdateDatabaseBackup({
      ...params,
      expectedGenerations:
        params.backup.postMigrationGenerations ?? params.backup.sourceGenerations,
    });
    if (migratedPaths === null) {
      return refuse("databases changed after migration; the writer is unknown");
    }
    params.assertCurrent();
    const step: UpdateStepResult = {
      name: "database rollback",
      command: "restore pre-migration databases",
      cwd: params.backup.directory,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      diagnostics: [
        `Restored pre-migration databases from ${params.backup.directory}.`,
        ...migratedPaths.map(
          (file) => `Migrated database file retained for manual recovery: ${file}`,
        ),
      ],
    };
    params.result.steps.push(step);
    params.progress?.onStepComplete?.({ ...step, index: 0, total: 0 });
    return true;
  } catch (cause) {
    // A partly restored shared ledger must never be reopened by candidate
    // finalization: that would migrate the recovery image again.
    throw new UpdateCommandRecoveryPendingError(
      `Database rollback could not finish; keep the Gateway stopped. Preserve ${params.backup.directory} and <database>.migrated-${params.runId}. Run the compatible candidate's Doctor to inspect recovery before restarting.`,
      { cause },
    );
  }
}
