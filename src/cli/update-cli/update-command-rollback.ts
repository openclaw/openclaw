import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV } from "../../config/future-version-guard.js";
import {
  hashConfigRaw,
  normalizeConfigIoDeps,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
} from "../../config/io.read-helpers.js";
import { withConfigMutationLock } from "../../config/mutate.js";
import { resolveStateDir } from "../../config/paths.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import { replaceFileAtomic } from "../../infra/replace-file.js";
import {
  readUpdateStateSchemaVersions,
  resolveUpdateStateContentVersion,
  updateStateSchemaVersionsMatch,
  type UpdateStateSchemaVersion,
} from "../../infra/update-candidate-state.js";
import { NativePackageRollbackError } from "../../infra/update-native-package-stage.js";
import type { UpdateRecoveryBackupRef } from "../../infra/update-recovery-backup-contract.js";
import {
  restoreUpdateRecoveryBackup,
  verifyUpdateRecoveryBackup,
  writeUpdateRecoveryBackupOutcome,
} from "../../infra/update-recovery-backup.js";
import {
  assertUpdateRecoveryConfigUnchanged,
  withUpdateRecoveryConfigValidation,
} from "../../infra/update-recovery-config-writes.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import {
  assertUpdateRecoveryAdmission,
  assertUpdateRecoveryBackupAdmission,
} from "../../infra/update-run-recovery-admission.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { confirmGatewayReachable } from "../daemon-cli/restart-health-probe.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  readUpdateConfigSnapshot,
  type UpdateConfigSnapshot,
} from "./update-command-config-snapshot.js";
import { readPackageUpdateIdentity } from "./update-command-package.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import {
  createWindowsTaskAutoStartGuard,
  revalidateManagedGatewayServiceAfterUpdate,
} from "./update-command-service-maintenance.js";
import { assertGatewayServiceManagementAllowedForUpdate } from "./update-command-service-plan.js";
import {
  maybeRestartService,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  resolveUpdatedGatewayRestartPort,
  type PreManagedServiceStop,
} from "./update-command-service.js";

/** Restore the verified state set before restarting the retained package. */
export async function rollbackFailedUpdate(params: {
  result: UpdateRunResult;
  previousRoot: string;
  packageTransaction?: PackageUpdateTransaction;
  updateRecoveryBackup?: UpdateRecoveryBackupRef;
  rollbackBlockedReason?: "state-migrated-no-rollback" | "rollback-state-unverified";
  schemaVersions?: UpdateStateSchemaVersion[];
  candidateSchemaVersions?: OpenClawSchemaVersions;
  previousSchemaVersions?: OpenClawSchemaVersions;
  previousVerified?: boolean;
  configSnapshot: ConfigFileSnapshot;
  activationConfig?: UpdateConfigSnapshot;
  opts: UpdateCommandOptions;
  preManagedServiceStop?: PreManagedServiceStop;
  timeoutMs: number;
  nodeRunner?: string;
  invocationCwd?: string;
}): Promise<{
  result: UpdateRunResult;
  rolledBack: boolean;
  stoppedForRollback?: PreManagedServiceStop;
  verifiedAtMs?: number;
  pendingRecoveryReason?: string;
  stateRestored?: boolean;
}> {
  const { preManagedServiceStop: before, packageTransaction, opts } = params;
  const run = opts.run;
  const executor = run?.executorFence;
  const assertCurrent = () => {
    if (opts.run !== run || run?.executorFence !== executor) {
      throw new Error("Package rollback lost its original executor.");
    }
    executor?.assertCurrent();
  };
  let result = params.result;
  let stateRestored = false;
  let recoveryManifest: Awaited<ReturnType<typeof verifyUpdateRecoveryBackup>> | undefined;
  let stoppedForRollback: PreManagedServiceStop | undefined;
  const failed = async (reason: string, detail = reason) => {
    const failure: UpdateRunResult = {
      ...result,
      status: "error",
      reason:
        result.recovery?.serviceRestartSafe === true && result.recovery.packageRollbackVerified
          ? (params.result.reason ?? reason)
          : reason,
    };
    if (!params.updateRecoveryBackup || stateRestored) {
      return { result: failure, rolledBack: false, stoppedForRollback, stateRestored };
    }
    let recoveryDetail = `${detail} Retained update-recovery set: ${params.updateRecoveryBackup.manifestPath}. Keep the Gateway stopped and run \`npx openclaw@latest doctor --fix\`.`;
    try {
      assertCurrent();
      // Until state is restored, the backup outcome is the safe durable report;
      // the previous runtime cannot write a forward-migrated run ledger.
      await writeUpdateRecoveryBackupOutcome(
        params.updateRecoveryBackup,
        { status: "restore-failed", error: recoveryDetail },
        { assertOwned: assertCurrent },
      );
    } catch (error) {
      recoveryDetail += ` Backup failure outcome could not be recorded: ${formatErrorMessage(error)}.`;
    }
    failure.recovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" };
    failure.steps = [
      ...failure.steps,
      {
        name: "state rollback",
        command: "npx openclaw@latest doctor --fix",
        cwd: params.previousRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail: recoveryDetail,
      },
    ];
    return {
      result: failure,
      rolledBack: false,
      stoppedForRollback,
      stateRestored: false,
      pendingRecoveryReason: recoveryDetail,
    };
  };
  const env = before?.serviceEnv ?? opts.run?.env ?? process.env;
  const assertAdmission = (admissionEnv: NodeJS.ProcessEnv) =>
    params.updateRecoveryBackup
      ? assertUpdateRecoveryBackupAdmission({ env: admissionEnv }, assertCurrent)
      : assertUpdateRecoveryAdmission({ env: admissionEnv });
  if (!opts.recovery) {
    try {
      assertCurrent();
      // A lost live context (including the same run ID) is not permission to
      // fall back to legacy rollback, even when publication removed the main DB.
      await assertAdmission(env);
      assertCurrent();
      // Service authority and diagnostic history can select distinct state
      // roots. Neither may contain pending recovery before legacy mutation.
      if (
        opts.run &&
        resolveOpenClawStateSqlitePath(opts.run.env) !== resolveOpenClawStateSqlitePath(env)
      ) {
        await assertAdmission(opts.run.env);
        assertCurrent();
      }
    } catch (error) {
      if (params.updateRecoveryBackup) {
        return failed("rollback-state-unverified", formatErrorMessage(error));
      }
      return {
        result: {
          ...params.result,
          status: "error",
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        },
        rolledBack: false,
        pendingRecoveryReason: formatErrorMessage(error),
      };
    }
  }
  if (opts.recovery) {
    // Retained full-state recovery is inspection-only in this delivery. Never
    // downgrade its claim to package-only rollback or rewrite its journal.
    return {
      result: {
        ...params.result,
        status: "error",
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      },
      rolledBack: false,
      pendingRecoveryReason:
        "Full-state checkpoint recovery is deferred; the retained record and artifacts were left unchanged.",
    };
  }
  const config =
    params.configSnapshot.sourceConfigBeforeMigrations ?? params.configSnapshot.sourceConfig;
  const configSnapshot = params.activationConfig ?? {
    path: params.configSnapshot.path,
    raw: params.configSnapshot.raw,
    hash: hashConfigRaw(params.configSnapshot.raw),
  };
  const recoveryEnv = { ...env, [ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV]: "1" };
  const port = before?.stopped
    ? await resolveUpdatedGatewayRestartPort({ config, serviceEnv: env })
    : undefined;
  const stateUnchanged = async () => {
    assertCurrent();
    const baseline = params.schemaVersions;
    const current = await readUpdateStateSchemaVersions({
      stateDir: resolveStateDir(env),
      config,
      env,
      root: result.root ?? null,
      nodeRunner: params.nodeRunner,
    });
    assertCurrent();
    const sharedPath = resolveOpenClawStateSqlitePath(env);
    if (
      baseline === undefined ||
      !updateStateSchemaVersionsMatch(baseline, current, {
        sharedPath,
        candidateSchemaVersions: params.candidateSchemaVersions,
      })
    ) {
      return false;
    }
    const baselineVersions = new Map(
      baseline.map((entry) => [entry.path, resolveUpdateStateContentVersion(entry)]),
    );
    for (const entry of current) {
      const version = resolveUpdateStateContentVersion(entry);
      if (version === null || baselineVersions.get(entry.path) != null) {
        continue;
      }
      // First-use creation is not migration, but the retained runtime must still
      // support that new store before replacing a reachable candidate.
      const kind = entry.path === sharedPath ? "state" : "agent";
      const supported = params.previousSchemaVersions?.[kind];
      if (supported === undefined || version > supported) {
        throw new Error(
          `Automatic rollback refused: newly created ${kind} database ${entry.path} uses schema ${version}; retained previous package support is ${supported ?? "unknown"}. Keep the candidate installed.`,
        );
      }
    }
    await assertConfigUnchanged();
    assertCurrent();
    return true;
  };
  let failureReason = "rollback-state-unverified";
  const assertConfigUnchanged = async () => {
    assertCurrent();
    if (params.updateRecoveryBackup) {
      await assertUpdateRecoveryConfigUnchanged(params.updateRecoveryBackup, {
        assertOwned: assertCurrent,
      });
      return;
    }
    let unchanged =
      params.activationConfig?.doctorOwned !== false &&
      (await readUpdateConfigSnapshot(configSnapshot.path)).hash === configSnapshot.hash;
    if (unchanged && params.configSnapshot.includedPaths?.length) {
      // Only the root file is restored. Resolve its captured include graph so
      // edits to separate config files cannot escape the original state guard.
      const deps = normalizeConfigIoDeps({ env: { ...env } });
      const included = resolveConfigIncludesForRead(
        params.configSnapshot.parsed,
        params.configSnapshot.path,
        deps,
      );
      unchanged = isDeepStrictEqual(
        config,
        resolveConfigForRead(included, deps.env).resolvedConfigRaw,
      );
    }
    assertCurrent();
    if (!unchanged) {
      failureReason = "state-migrated-no-rollback";
      const detail = `Configuration ${configSnapshot.path} or its included files changed after activation; automatic rollback was refused to preserve those edits.`;
      result = {
        ...result,
        steps: [
          ...result.steps,
          {
            name: "config rollback",
            command: "restore pre-update config",
            cwd: params.previousRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: detail,
          },
        ],
      };
      throw new Error(detail);
    }
  };
  const stop = async () => {
    assertCurrent();
    failureReason = "service-revalidation-failed";
    // The parent binary can be older than the candidate's stamp even before bytes are restored.
    // This existing recovery allowance belongs only to this guarded stop invocation.
    const stopped = await withOwnedManagedUpdateEnv(recoveryEnv, () =>
      maybeStopManagedServiceBeforeMutableUpdate({
        updateRun: opts.run,
        deferLedgerWrites: Boolean(params.updateRecoveryBackup),
        updateInstallKind: "package",
        root: result.root ?? params.previousRoot,
        shouldRestart: true,
        jsonMode: opts.json === true,
        expectedService: before,
        allowInstallRootChange: packageTransaction !== undefined,
        timeoutMs: params.timeoutMs,
      }),
    );
    assertCurrent();
    if (stopped.serviceEnv) {
      stopped.serviceEnv = { ...stopped.serviceEnv };
      delete stopped.serviceEnv[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV];
    }
    // Reinspection of an already disabled task creates no new suspension owner.
    // Keep the original authority through rollback activation and final settlement.
    stopped.windowsTaskAutoStartRecovery ??= before?.windowsTaskAutoStartRecovery;
    stoppedForRollback = stopped;
    if (
      stopped.blockMessage ||
      stopped.serviceMutationAllowed === false ||
      (stopped.running && !stopped.stopped)
    ) {
      throw new Error(stopped.blockMessage ?? "Candidate service could not be stopped safely.");
    }
    return stopped;
  };
  const stopIfUnreachable = async () => {
    assertCurrent();
    if (port !== undefined) {
      const { reachable } = await confirmGatewayReachable({ port, env });
      assertCurrent();
      if (!reachable) {
        await stop();
      }
    }
  };
  try {
    assertCurrent();
    if (params.updateRecoveryBackup) {
      const manifest = await verifyUpdateRecoveryBackup(params.updateRecoveryBackup);
      recoveryManifest = manifest;
      assertCurrent();
      if (manifest.runId !== run?.runId || manifest.installRoot !== params.previousRoot) {
        throw new Error("Update recovery backup does not belong to this run and installation.");
      }
      await assertConfigUnchanged();
    } else if (params.rollbackBlockedReason) {
      result.steps.push({
        name: "state rollback",
        command: "npx openclaw@latest doctor --fix",
        cwd: params.previousRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail:
          "Automatic rollback refused: no verified update-recovery set is available. Run `npx openclaw@latest doctor --fix` to recover with a compatible runtime.",
      });
      await stopIfUnreachable();
      return failed(params.rollbackBlockedReason);
    }
    if (!params.updateRecoveryBackup && !params.schemaVersions) {
      await stopIfUnreachable();
      return failed("rollback-state-unverified");
    }
    if (!params.updateRecoveryBackup && !(await stateUnchanged())) {
      await stopIfUnreachable();
      return failed("state-migrated-no-rollback");
    }
    await packageTransaction?.assertRollbackSafe?.();
    assertCurrent();
    const stopped = before?.stopped ? await stop() : undefined;
    const restore = async () => {
      // Recheck after stop so a final startup migration cannot race the first read.
      failureReason = "rollback-state-unverified";
      if (params.updateRecoveryBackup) {
        await verifyUpdateRecoveryBackup(params.updateRecoveryBackup);
        await assertConfigUnchanged();
      }
      if (!params.updateRecoveryBackup && !(await stateUnchanged())) {
        return failed("state-migrated-no-rollback");
      }
      failureReason = "source-rollback-failed";
      if (!packageTransaction) {
        throw new Error("The retained package transaction is unavailable.");
      }
      assertCurrent();
      const { activePackageRoot, ...restored } = await packageTransaction.rollback(assertCurrent);
      // Restoration changes the active runtime before any later reporting or
      // restart can fail. Carry that identity through every recovery outcome.
      result = {
        ...result,
        root: activePackageRoot ?? undefined,
        after: undefined,
        steps: [...result.steps, restored],
      };
      assertCurrent();
      if (restored.exitCode === 0) {
        // The transaction verified the previous package. Do not gate its restart
        // on an extra diagnostic read whose result would be discarded.
        result.after = result.before;
        result.recovery = {
          serviceRestartSafe: false,
          packageRollbackVerified: true,
          reason: "runtime-verification-failed",
        };
      } else if (activePackageRoot) {
        result.after = await readPackageUpdateIdentity(activePackageRoot);
        assertCurrent();
      }
      if (opts.run && !params.updateRecoveryBackup) {
        recordUpdateRunStep(
          opts.run.runId,
          {
            step: "package rollback",
            status: restored.exitCode === 0 ? "completed" : "failed",
            endedAtMs: Date.now(),
            ...(restored.reason ? { detail: restored.stderrTail ?? restored.reason } : {}),
          },
          { env: opts.run.env },
        );
      }
      if (restored.exitCode !== 0) {
        return failed(
          restored.reason ?? "source-rollback-failed",
          restored.stderrTail ?? restored.reason ?? "source-rollback-failed",
        );
      }
      failureReason = "rollback-state-unverified";
      if (params.updateRecoveryBackup) {
        await restoreUpdateRecoveryBackup(params.updateRecoveryBackup, {
          assertOwned: assertCurrent,
        });
        assertCurrent();
        stateRestored = true;
        try {
          await writeUpdateRecoveryBackupOutcome(
            params.updateRecoveryBackup,
            { status: "restored" },
            { assertOwned: assertCurrent },
          );
        } catch (error) {
          assertCurrent();
          const warning = `State restored; backup outcome could not be recorded at ${params.updateRecoveryBackup.manifestPath}: ${formatErrorMessage(error)}`;
          defaultRuntime.error(`Warning: ${warning}`);
          result.steps.push({
            name: "backup outcome warning",
            command: "openclaw update",
            cwd: params.previousRoot,
            durationMs: 0,
            exitCode: 0,
            stderrTail: warning,
          });
        }
        const detail = `Restored verified update-recovery set: ${params.updateRecoveryBackup.manifestPath}`;
        result.steps.push({
          name: "state rollback",
          command: "restore update-recovery backup",
          cwd: params.previousRoot,
          durationMs: 0,
          exitCode: 0,
          stdoutTail: detail,
        });
        if (run) {
          recordUpdateRunStep(
            run.runId,
            { step: "state rollback", status: "completed", endedAtMs: Date.now(), detail },
            { env: run.env },
          );
          recordUpdateRunStep(
            run.runId,
            { step: "package rollback", status: "completed", endedAtMs: Date.now() },
            { env: run.env },
          );
        }
      } else if (configSnapshot.hash === hashConfigRaw(configSnapshot.raw)) {
        await assertConfigUnchanged();
      } else {
        await assertConfigUnchanged();
        if (configSnapshot.raw === null) {
          await fs.rm(configSnapshot.path, { force: true });
        } else {
          await replaceFileAtomic({
            filePath: configSnapshot.path,
            content: configSnapshot.raw,
            mode: 0o600,
            preserveExistingMode: false,
            beforeRename: assertConfigUnchanged,
          });
        }
      }
      assertCurrent();
      return undefined;
    };
    // Unchanged config needs only the legacy read checks, including read-only
    // installs. Doctor-owned replacement must exclude config writers before
    // package rollback and retain that owner until config restoration settles.
    const restoreWithLocks = async () => {
      if (params.updateRecoveryBackup) {
        if (!recoveryManifest) {
          throw new Error("Verified update recovery manifest is unavailable.");
        }
        return await withUpdateRecoveryConfigValidation(
          params.updateRecoveryBackup,
          recoveryManifest,
          { assertOwned: assertCurrent },
          restore,
        );
      }
      return await withConfigMutationLock({ lockPath: configSnapshot.path }, restore);
    };
    const refused =
      !params.updateRecoveryBackup && configSnapshot.hash === hashConfigRaw(configSnapshot.raw)
        ? await restore()
        : await withOwnedManagedUpdateEnv(env, restoreWithLocks);
    assertCurrent();
    if (refused) {
      return refused;
    }
    // A no-service or --no-restart update owns file restoration only. Preserve
    // its original failure without claiming or changing a Gateway generation.
    if (!stopped || port === undefined) {
      return { result, rolledBack: false, stateRestored };
    }
    if (!params.previousVerified || !result.before?.version) {
      // Restoring retained bytes is safe after the schema fence. Starting the
      // previous runtime additionally requires its pre-activation verification.
      return failed("previous-version-unverified");
    }
    failureReason = "service-revalidation-failed";
    await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(
      stopped,
      true,
      createWindowsTaskAutoStartGuard({
        root: params.previousRoot,
        before: stopped,
        timeoutMs: params.timeoutMs,
      }),
      assertCurrent,
    );
    assertCurrent();
    // A failed candidate does not authorize its restart. The previous package's
    // pre-activation verification authorizes restarting this schema-neutral restoration.
    let verdict = stopped.serviceUpdateVerdict ?? before?.serviceUpdateVerdict;
    const nodeRunner = before?.serviceNodeRunner ?? params.nodeRunner;
    if (verdict?.kind === "owned" && verdict.refreshDefinition) {
      try {
        await runUpdatedInstallGatewayCommand(
          {
            result,
            opts,
            invocationEnv: env,
            serviceInstallEnv: before?.serviceDefinitionEnv,
            nodeRunner,
            timeoutMs: params.timeoutMs,
            invocationCwd: params.invocationCwd,
            assertCurrent,
          },
          "install",
        );
      } catch (error) {
        if (!stateRestored) {
          throw error;
        }
        const warning = `Service definition refresh failed after state restoration: ${formatErrorMessage(error)}`;
        defaultRuntime.error(`Warning: ${warning}`);
        result.steps.push({
          name: "service definition warning",
          command: "openclaw gateway install",
          cwd: params.previousRoot,
          durationMs: 0,
          exitCode: 0,
          stderrTail: warning,
        });
      }
      const state = await readGatewayServiceState(resolveGatewayService(), {
        env: recoveryEnv,
        requireEffective: true,
        requireLoadedCommand: true,
        validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
        timeoutMs: params.timeoutMs,
      });
      assertCurrent();
      verdict = await revalidateManagedGatewayServiceAfterUpdate({
        state,
        root: params.previousRoot,
        preManagedServiceStop: stopped,
      });
    }
    assertCurrent();
    result.recovery = {
      serviceRestartSafe: true,
      packageRollbackVerified: true,
      version: result.before.version,
      ...(result.before.buildId ? { buildId: result.before.buildId } : {}),
    };
    assertCurrent();
    if (opts.run) {
      recordUpdateRunStep(
        opts.run.runId,
        {
          step: "previous generation restoration",
          status: "completed",
          endedAtMs: Date.now(),
        },
        { env: opts.run.env },
      );
    }
    failureReason = "restart-unhealthy";
    let verifiedAtMs: number | undefined;
    const restartOutcome = await maybeRestartService({
      shouldRestart: true,
      result,
      opts,
      refreshServiceEnv: false,
      serviceUpdateVerdict: verdict,
      serviceManagerUid: before?.serviceManagerUid,
      serviceEnv: recoveryEnv,
      serviceInstallEnv: before?.serviceDefinitionEnv,
      gatewayPort: port,
      requireRunningServiceAfterRestart: true,
      timeoutMs: params.timeoutMs,
      // Prior verification covers this executable too; refreshing with the
      // candidate's newer Node would not restore the previously serving runtime.
      nodeRunner,
      invocationCwd: params.invocationCwd,
      onVerified: (at) => {
        verifiedAtMs = at;
      },
    });
    assertCurrent();
    const healthy = restartOutcome === "ok";
    return {
      result: {
        ...result,
        recovery: healthy ? { ...result.recovery, service: "healthy" } : result.recovery,
      },
      rolledBack: healthy,
      stateRestored,
      stoppedForRollback,
      ...(verifiedAtMs === undefined ? {} : { verifiedAtMs }),
    };
  } catch (error) {
    let detail = formatErrorMessage(error);
    if (params.updateRecoveryBackup && !stateRestored) {
      return failed("rollback-state-unverified", detail);
    }
    try {
      assertCurrent();
    } catch (cause) {
      return {
        result: {
          ...result,
          status: "error",
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        },
        rolledBack: false,
        stoppedForRollback,
        pendingRecoveryReason: formatErrorMessage(cause),
      };
    }
    if (error instanceof NativePackageRollbackError) {
      failureReason = error.reason;
    }
    if (
      failureReason === "rollback-state-unverified" ||
      failureReason === "state-migrated-no-rollback" ||
      error instanceof NativePackageRollbackError
    ) {
      const reason = failureReason;
      try {
        await stopIfUnreachable();
        failureReason = reason;
      } catch (stopError) {
        detail += `; ${formatErrorMessage(stopError)}`;
      }
    }
    assertCurrent();
    if (opts.run) {
      recordUpdateRunStep(
        opts.run.runId,
        {
          step: "package rollback",
          status: "failed",
          endedAtMs: Date.now(),
          detail,
        },
        { env: opts.run.env },
      );
    }
    return failed(failureReason);
  }
}
