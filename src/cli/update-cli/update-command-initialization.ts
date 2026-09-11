import fs from "node:fs/promises";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { SQLITE_SIDECAR_SUFFIXES } from "../../infra/sqlite-files.js";
import { acquireGatewayLifecycleCoordinator } from "../../infra/state-database-coordinator.js";
import { compareSemverStrings } from "../../infra/update-check.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import {
  requestUpdateDowngradeConfirmation,
  UpdatePreMutationError,
  type UpdateCommandOptions,
} from "./shared.js";
import type { UpdateCommandExecutor } from "./update-command-executor.js";
import type { StagedPackageInstallUpdate } from "./update-command-package.js";
import { runPackageUpdateDoctor } from "./update-command-package.js";
import { UnreportedUpdateAdmissionOutcome } from "./update-command-result.js";
import type { resolveUpdateCommandTarget } from "./update-command-target.js";

export type InitializedUpdate = {
  env: NodeJS.ProcessEnv;
  runId: string;
  executor: UpdateCommandExecutor;
  registerRun: (run: NonNullable<UpdateCommandOptions["run"]>) => Promise<void>;
  target: NonNullable<Awaited<ReturnType<typeof resolveUpdateCommandTarget>>>;
  databasePath: string;
  configPath: string;
  stagedPackage?: StagedPackageInstallUpdate;
  downgradeConfirmed?: boolean;
};

export async function confirmFreshUpdateDowngrade(params: {
  target: InitializedUpdate["target"];
  opts: UpdateCommandOptions;
  controlPlaneUpdateSentinelMeta: ConstructorParameters<
    typeof UnreportedUpdateAdmissionOutcome
  >[0]["controlPlaneUpdateSentinelMeta"];
}): Promise<void> {
  const { target, opts } = params;
  if (!target.downgradeRisk || opts.yes) {
    return;
  }
  const decision = await requestUpdateDowngradeConfirmation({
    json: Boolean(opts.json),
    currentVersion: target.currentVersion,
    targetVersion: target.targetVersion,
    tag: target.tag,
  });
  if (decision === "confirmed") {
    return;
  }
  throw new UnreportedUpdateAdmissionOutcome(
    {
      root: target.root,
      installKind: target.updateInstallKind,
      opts,
      controlPlaneUpdateSentinelMeta: params.controlPlaneUpdateSentinelMeta,
      reason: decision === "cancelled" ? "cancelled" : "downgrade-confirmation-required",
      message:
        decision === "cancelled"
          ? "Update cancelled."
          : "Downgrade confirmation required.\nDowngrading can break configuration. Re-run in a TTY to confirm.",
    },
    { exitCode: decision === "cancelled" ? 0 : 1 },
  );
}

/** Keep the original outcome when its owned-state cleanup also fails. */
export async function withUpdateInitializationCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => void | Promise<void>,
): Promise<T> {
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      if (cleanupError === error) {
        throw error;
      }
      throw new AggregateError([error, cleanupError], "Update initialization and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
  await cleanup();
  return result;
}

/** Missing state is not permission to recreate an interrupted database family. */
export async function updateStateNeedsInitialization(env: NodeJS.ProcessEnv): Promise<boolean> {
  await assertUpdateRecoveryAdmission({ env });
  const databasePath = resolveOpenClawStateSqlitePath(env);
  await assertOpenClawStateWriteAllowedAtPath({
    databasePath,
    env,
    recoverOrphanedSidecars: false,
  });
  try {
    await fs.lstat(databasePath);
    return false;
  } catch (error) {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    try {
      await fs.lstat(`${databasePath}${suffix}`);
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    throw new UpdatePreMutationError(
      "target-state-initialization",
      "The state database is missing but SQLite sidecars remain. Preserve the database family and restore its main file before updating.",
    );
  }
  return true;
}

export function acquireLegacyUpdateInitializationFence(params: {
  env: NodeJS.ProcessEnv;
  targetVersion: string;
  targetSchemas: OpenClawSchemaVersions;
}) {
  const databasePath = resolveOpenClawStateSqlitePath(params.env);
  const comparison = compareSemverStrings(params.targetVersion, "2026.7.1");
  // Released schema-1 writers through 2026.7.1 predate the external schema
  // coordinator. Hold its existing Gateway fence so a modern process cannot
  // create/migrate this profile while that legacy child initializes it.
  return params.targetSchemas.state === 1 && comparison !== null && comparison <= 0
    ? acquireGatewayLifecycleCoordinator({ databasePath, busyTimeoutMs: 0 })
    : undefined;
}

/** The selected release owns bootstrap; the parent may only inspect its result. */
export async function initializeUpdateStateFromTarget(
  params: Parameters<typeof runPackageUpdateDoctor>[0] & {
    env: NodeJS.ProcessEnv;
    assertCurrent: () => void;
    checkSchemas: () => Promise<void>;
  },
): Promise<void> {
  await params.checkSchemas();
  params.assertCurrent();
  // npm lifecycle hooks may already have created the database. The selected
  // Doctor must still validate and migrate authored config before activation.
  await updateStateNeedsInitialization(params.env);
  params.assertCurrent();
  const result = await runPackageUpdateDoctor({ ...params, managedServiceEnv: params.env });
  params.assertCurrent();
  await params.checkSchemas();
  if (!result || (result.exitCode !== 0 && !result.advisory)) {
    throw new UpdatePreMutationError(
      "target-state-initialization",
      result?.stderrTail ?? "The selected release could not initialize its state database.",
    );
  }
  if (await updateStateNeedsInitialization(params.env)) {
    throw new UpdatePreMutationError(
      "target-state-initialization",
      "The selected release did not initialize a compatible state database.",
    );
  }
}
