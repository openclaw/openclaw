import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshot,
} from "../../config/config.js";
import { resolveGatewayPort } from "../../config/paths.js";
import { resolveServiceManagerEnv } from "../../daemon/service-process-env.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { settlePendingPackageActivation } from "../../infra/package-update-activation.js";
import { tryProcessCwd } from "../../infra/safe-cwd.js";
import {
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
} from "../../infra/update-channels.js";
import { compareSemverStrings, resolveNpmChannelTag } from "../../infra/update-check.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { prepareManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { resolveLegacyGatewayManagedUpdateLeaseDatabasePath } from "../../infra/update-managed-service-handoff-legacy-store.js";
import { ManagedHandoffCustodyRetainedError } from "../../infra/update-managed-service-handoff-reclamation.js";
import type { PluginCohortRecoveryPair } from "../../infra/update-plugin-cohort-schema.js";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import {
  inspectUpdateRepairDriverAdmission,
  inspectNewerRecoveryHistory,
  needsPostCoreRepair,
  isFreshUnacknowledgedAbandonedUpdateRun,
  recordedUpdateRunDrivers,
  inspectUpdateRunAbandonment,
} from "../../infra/update-run-activity.js";
import { inspectUpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  acknowledgeAbandonedUpdateRun,
  createUpdateRun,
  listUpdateRuns,
  reconcileAbandonedUpdateRunsAsync,
  reconcilePackageOwnerRefusal,
  recordUpdateRunRepairContinuation,
} from "../../infra/update-run-ledger.js";
import {
  isAbandonedUpdateRun,
  isAcknowledgedAbandonedUpdateRun,
  isUnacknowledgedPackageOwnerRefusal,
} from "../../infra/update-run-record.js";
import {
  assertUpdateRecoveryAdmission,
  inspectPluginCohortRecoveryAdmission,
} from "../../infra/update-run-recovery-admission.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery-types.js";
import { pluginCohortRecoveryMatchesSource } from "../../infra/update-run-recovery.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership-preflight.js";
import { formatCliCommand } from "../command-format.js";
import { getGatewayChannelWarnings } from "../daemon-cli/restart-health-diagnostics.js";
import {
  confirmGatewayReachable,
  resolveGatewayRestartProbeContext,
  waitForGatewayHttpReadiness,
} from "../daemon-cli/restart-health-probe.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import { hasCliProcessScope } from "../runtime-cleanup-scope.js";
import { refuseHostOwnedUpdate } from "./host-owned.js";
import {
  parseUpdateTimeoutMs,
  resolveUpdateRoot,
  resolveTargetVersion,
  type UpdateFinalizeOptions,
} from "./shared.js";
import { withUpdateDatabaseEngine } from "./update-command-database-engine.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";
import { updateFinalizeCommand, type UpdateCoreCompletion } from "./update-command-finalize.js";
import { refuseImmutableUpdateActivation } from "./update-command-immutable.js";
import { resolveServiceRefreshEnv } from "./update-command-service-env.js";
import { updateMaintenanceError } from "./update-maintenance-error.js";
import {
  reportRetainedUpdateCustody,
  type RetainedUpdateCustodyReport,
} from "./update-retained-custody.js";

export function updateRepairCommand(opts: UpdateFinalizeOptions): Promise<void> {
  const env = resolveServiceRefreshEnv(process.env, tryProcessCwd());
  return withUpdateDatabaseEngine(env, () => repairUpdate(opts)).catch((error: unknown) => {
    throw updateMaintenanceError(error);
  });
}

async function repairUpdate(opts: UpdateFinalizeOptions): Promise<void> {
  // Recovery refusal precedes discovery; later mutation checks still revalidate.
  let pluginCohort: PluginCohortRecoveryPair | undefined;
  try {
    await assertUpdateRecoveryAdmission({ env: process.env });
  } catch (error) {
    pluginCohort = await inspectPluginCohortRecoveryAdmission({ env: process.env });
    if (!pluginCohort) {
      throw error;
    }
  }
  const discoveredRoot = await resolveUpdateRoot();
  const installKey = resolveUpdateInstallRoot(discoveredRoot);
  if (pluginCohort && pluginCohort.cohort.installKey !== installKey) {
    throw new Error("Plugin cohort recovery belongs to a different installation.");
  }
  await refuseHostOwnedUpdate(discoveredRoot, opts);
  await refuseImmutableUpdateActivation(discoveredRoot, opts);
  const timeoutMs = parseUpdateTimeoutMs(opts.timeout);
  const env = resolveServiceRefreshEnv(process.env, tryProcessCwd());
  const options = { env, busyTimeoutMs: timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS };
  if (pluginCohort && !pluginCohortRecoveryMatchesSource(pluginCohort, options)) {
    throw new Error("Plugin cohort recovery selected a different state or configuration path.");
  }
  assertConfigWriteAllowedInCurrentMode({ env });
  await assertOpenClawStateWriteAllowedAtPath({
    databasePath: resolveOpenClawStateSqlitePath(env),
    env,
    recoverOrphanedSidecars: false,
  });
  let activeRuns = listUpdateRuns({ active: true, limit: 100 }, options);
  const inheritedRunId = env[UPDATE_RUN_ID_ENV];
  let admission = inspectUpdateRepairDriverAdmission(activeRuns, inheritedRunId);
  const reconcileUnderRepairOwnership = async (repairOwnership: UpdateRecoveryFence) => {
    // Settle independently: an unresolved sibling must not discard proven progress.
    for (const run of activeRuns) {
      const reconciled = await reconcileAbandonedUpdateRunsAsync(
        { explicit: true, runIds: [run.runId] },
        { ...options, repairOwnership },
      );
      for (const retired of reconciled) {
        const hosts = recordedUpdateRunDrivers(retired)
          .map((driver) => driver.host)
          .join(", ");
        const age = Math.max(0, Math.floor((Date.now() - retired.createdAtMs) / 1_000));
        defaultRuntime.error(
          `Warning: abandoned update ${retired.runId} on ${hosts || "an unrecorded host"} (age ${age}s); retired under exclusive update and state ownership.`,
        );
      }
    }
    activeRuns = listUpdateRuns({ active: true, limit: 100 }, options);
    admission = inspectUpdateRepairDriverAdmission(activeRuns, inheritedRunId);
  };
  if (
    !pluginCohort &&
    admission.kind === "conflict" &&
    !inheritedRunId &&
    activeRuns.some((run) =>
      recordedUpdateRunDrivers(run).some((driver) => inspectUpdateRunDriver(driver) === "unknown"),
    )
  ) {
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const repairOwnership = await executor
        .enter(resolveUpdateInstallRoot(discoveredRoot))
        .catch((error: unknown) => {
          throw new Error(
            `Repair could not acquire exclusive update ownership. Wait for the update or stop it through its owning host or supervisor, then retry openclaw update repair. ${String(error)}`,
            { cause: error },
          );
        });
      await reconcileUnderRepairOwnership(repairOwnership);
    });
  }
  // This predicts only whether native custody could reconcile ambiguous history;
  // it grants no effects and never defers a proven live driver.
  const deferCohortDriverAdmission =
    pluginCohort &&
    !inheritedRunId &&
    activeRuns.every(
      (run) =>
        inspectUpdateRunAbandonment(run, { explicit: true, exclusiveRepair: true }) !== undefined,
    );
  if (admission.kind === "conflict" && !deferCohortDriverAdmission) {
    throw new Error(admission.message);
  }
  const validChannel = opts.channel === undefined || normalizeUpdateChannel(opts.channel) !== null;
  let retained: RetainedUpdateCustodyReport | undefined;
  const prepareHandoffRepair = async () => {
    // Admission keys custody by the canonical installation, not a lexical slot.
    const root = resolveUpdateInstallRoot(await resolveUpdateRoot());
    if (pluginCohort && root !== installKey) {
      throw new Error("Plugin cohort repair selected a different installation before custody.");
    }
    try {
      const repair = await (
        await prepareManagedHandoffLeaseStore()
      ).prepareRepair(root, env, timeoutMs);
      const legacy = resolveLegacyGatewayManagedUpdateLeaseDatabasePath();
      if (repair || !legacy || !fs.existsSync(legacy)) {
        return repair;
      }
      // An earlier macOS Gateway's handoff stays in its own store until repaired.
      const store = await prepareManagedHandoffLeaseStore({
        databasePath: legacy,
        serviceManagerEnv: resolveServiceManagerEnv(),
      });
      return await store.prepareRepair(root, env, timeoutMs);
    } catch (error) {
      if (!(error instanceof ManagedHandoffCustodyRetainedError)) {
        throw error;
      }
      // Retained custody blocks the next update, not this repair's own maintenance.
      retained = reportRetainedUpdateCustody(error.custody, env);
      defaultRuntime.error(`Warning: ${error.message}`);
      return null;
    }
  };
  using handoff =
    hasCliProcessScope() &&
    !inheritedRunId &&
    !env.OPENCLAW_UPDATE_RUN_HANDOFF &&
    !env[POST_CORE_UPDATE_ENV] &&
    validChannel
      ? await prepareHandoffRepair()
      : null;
  if (pluginCohort) {
    if (
      !validChannel ||
      inheritedRunId ||
      env.OPENCLAW_UPDATE_RUN_HANDOFF ||
      env[POST_CORE_UPDATE_ENV]
    ) {
      throw new Error("Plugin cohort recovery requires a fresh update repair invocation.");
    }
    const originalPair = pluginCohort;
    const settleCohort = async (ownership: UpdateRecoveryFence) => {
      const assertCurrent = () => {
        ownership.assertCurrent();
        if (resolveUpdateInstallRoot(discoveredRoot) !== installKey) {
          throw new Error("Plugin cohort recovery installation changed during repair.");
        }
      };
      assertCurrent();
      const current = await inspectPluginCohortRecoveryAdmission(
        options,
        originalPair.cohort.runId,
      );
      assertCurrent();
      if (
        !current ||
        current.cohort.transactionId !== originalPair.cohort.transactionId ||
        current.cohort.installKey !== installKey
      ) {
        throw new Error("Plugin cohort recovery changed before repair acquired ownership.");
      }
      if (current.cohort.disposition === "commit") {
        const [version, buildId] = await Promise.all([
          readPackageVersion(discoveredRoot),
          readBuiltGatewayBuildId(discoveredRoot),
        ]);
        assertCurrent();
        if (
          version !== current.reservation.to.version ||
          (buildId ?? null) !== current.reservation.to.buildId
        ) {
          throw new Error(
            "Plugin cohort commit does not match the installed candidate version and build.",
          );
        }
      }
      const { settleUpdatePluginCohort } = await import("../../plugins/update-cohort-recovery.js");
      assertCurrent();
      await settleUpdatePluginCohort({
        runId: current.cohort.runId,
        action: current.cohort.disposition === "commit" ? "commit" : "rollback",
        env,
        fence: { assertCurrent },
      });
      assertCurrent();
      // The plugin reservation is gone before ordinary history reconciliation.
      await assertUpdateRecoveryAdmission(options);
      assertCurrent();
      if (admission.kind === "conflict") {
        await reconcileUnderRepairOwnership({ assertCurrent });
      } else {
        activeRuns = listUpdateRuns({ active: true, limit: 100 }, options);
        admission = inspectUpdateRepairDriverAdmission(activeRuns, inheritedRunId);
      }
      if (admission.kind === "conflict") {
        throw new Error(admission.message);
      }
    };
    if (handoff) {
      await settleCohort(handoff);
    } else {
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const ownership = await executor.enter(installKey);
        if (captureUpdateCommandExecutorAuthority(ownership).installKey !== installKey) {
          throw new Error("Plugin cohort recovery lost its installation executor.");
        }
        await settleCohort(ownership);
      });
    }
    pluginCohort = undefined;
  }
  if (validChannel) {
    // Repair's claim now owns the installation; fresh admission would be refused.
    const settlement = await settlePendingPackageActivation(
      resolveUpdateInstallRoot(discoveredRoot),
      (settled) => {
        defaultRuntime.error(
          `Warning: previous package update operation ${settled.operationId} closed as ${settled.reason}. ${
            settled.retained
              ? `Recovery evidence retained at ${settled.retained}.`
              : "The original package and launchers remain unchanged."
          }${settled.detail ? ` ${settled.detail}` : ""}`,
        );
        if (settled.detail) {
          // The operation UUID identifies this repair receipt, not the original failed run.
          // Replaying it after interrupted reporting preserves the original update outcome.
          createUpdateRun(
            {
              runId: settled.operationId,
              trigger: "cli",
              settlement: {
                reason: settled.reason,
                detail: `${settled.detail} Operation ${settled.operationId}; evidence retained at ${settled.retained}.`,
              },
            },
            options,
          );
        }
      },
      undefined,
      handoff ? { owner: () => handoff.assertCurrent() } : undefined,
    );
    if (settlement?.warning) {
      defaultRuntime.error(`Warning: ${settlement.warning}`);
    }
  }
  // Capture Doctor-visible history before finalization admits its own newer run.
  // Terminal age limits the shortcut below, not successful repair acknowledgment.
  const recentRuns = listUpdateRuns({ limit: 100 }, options);
  const historicalRuns = recentRuns.filter(
    (run) => isAbandonedUpdateRun(run) && !isAcknowledgedAbandonedUpdateRun(run),
  );
  if (admission.kind === "continuation") {
    const continuation = admission.run;
    recordUpdateRunRepairContinuation(continuation.runId, inheritedRunId, options);
    return await updateFinalizeCommand(
      opts,
      [...activeRuns, ...historicalRuns]
        .filter((run) => run.runId !== continuation.runId)
        .map((run) => run.runId),
    );
  }
  const lastRun = recentRuns[0];
  if (
    !handoff &&
    !activeRuns.length &&
    !historicalRuns.length &&
    opts.channel === undefined &&
    !opts.acceptCapabilities &&
    lastRun &&
    isUnacknowledgedPackageOwnerRefusal(lastRun)
  ) {
    const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
    const root = await resolveUpdateRoot();
    const installedVersion = await readPackageVersion(root);
    const { channel } = resolveEffectiveUpdateChannel({
      configChannel: normalizeUpdateChannel(
        lastRun.target.channel ?? snapshot.config.update?.channel,
      ),
      currentVersion: installedVersion,
      installKind: "package",
    });
    if (snapshot.valid && (channel !== "dev" || lastRun.target.tag)) {
      const targetVersion =
        lastRun.target.version ??
        (lastRun.target.tag
          ? (await resolveTargetVersion(lastRun.target.tag, timeoutMs, { env })).version
          : (await resolveNpmChannelTag({ channel, timeoutMs, env })).version);
      await assertUpdateRecoveryAdmission(options);
      // Registry resolution awaited I/O; inspect the installed version again before recording recovery.
      const currentVersion = await readPackageVersion(root);
      const comparison = compareSemverStrings(currentVersion, targetVersion);
      if (comparison !== null && comparison >= 0) {
        assertConfigWriteAllowedInCurrentMode({ env });
        if (reconcilePackageOwnerRefusal(lastRun, options)) {
          reportRepairResult(
            opts,
            [lastRun.runId],
            `OpenClaw ${currentVersion} satisfies the package target ${targetVersion}. Acknowledged the package-owner refusal; no maintenance or service restart was needed.`,
            retained,
          );
          return;
        }
      }
    }
  }
  const recoveryRuns = activeRuns.length
    ? activeRuns
    : lastRun && isFreshUnacknowledgedAbandonedUpdateRun(lastRun)
      ? [lastRun]
      : [];
  const recoverySinceMs = recoveryRuns.length
    ? Math.min(...recoveryRuns.map((run) => run.createdAtMs))
    : undefined;
  const history = inspectNewerRecoveryHistory(recoverySinceMs, recentRuns);
  const recoveryRunIds = [
    ...new Set(
      [...recoveryRuns, ...historicalRuns, ...history.postCoreRuns].map((run) => run.runId),
    ),
  ];
  const finalizeRepair = async () => {
    try {
      // Driver death is a historical fact; maintenance completion is acknowledged separately.
      await reconcileAbandonedUpdateRunsAsync({ runIds: recoveryRunIds }, options);
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      defaultRuntime.error(
        `Warning: Update history reconciliation could not complete: ${String(error)}`,
      );
    }
    return await updateFinalizeCommand(opts, recoveryRunIds, handoff ?? undefined, retained);
  };

  if (
    handoff ||
    opts.channel !== undefined ||
    opts.acceptCapabilities ||
    recoverySinceMs === undefined ||
    recoveryRunIds.length !== recoveryRuns.length ||
    recoveryRuns.some(needsPostCoreRepair) ||
    history.postCoreRuns.length > 0 ||
    history.incomplete
  ) {
    return await finalizeRepair();
  }

  const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
  if (!snapshot.valid) {
    return await finalizeRepair();
  }
  const context = await resolveGatewayRestartProbeContext(env);
  const port = resolveGatewayPort(context.config, env);
  const root = await resolveUpdateRoot();
  const [gateway, http, expectedVersion, expectedBuildId] = await Promise.all([
    confirmGatewayReachable({ port, ...context, env }),
    waitForGatewayHttpReadiness({
      requireChannelHealth: false,
      config: context.config,
      port,
      attempts: 1,
      deadlineAt: performance.now() + Math.min(timeoutMs ?? 3_000, 3_000),
      delayMs: 0,
    }),
    readPackageVersion(root),
    readBuiltGatewayBuildId(root),
  ]);
  // An old Gateway can remain healthy after the package changed on disk, before
  // the interrupted updater recorded any post-core work.
  if (
    !gateway.reachable ||
    !expectedVersion ||
    !expectedBuildId ||
    gateway.gatewayVersion !== expectedVersion ||
    gateway.gatewayBuildId !== expectedBuildId ||
    gateway.activatedPluginErrors.length ||
    !(http.coreReady ?? (http.healthz === 200 && http.readyz === 200))
  ) {
    return await finalizeRepair();
  }

  // Health probes await network I/O. Recheck current rows before the ledger's
  // transaction revalidates each captured run's inactivity and driver identity.
  assertConfigWriteAllowedInCurrentMode({ env });
  const currentRuns = listUpdateRuns({ active: true, limit: 100 }, options);
  const currentAdmission = inspectUpdateRepairDriverAdmission(currentRuns, inheritedRunId);
  if (currentAdmission.kind === "conflict") {
    throw new Error(currentAdmission.message);
  }
  const currentHistory = inspectNewerRecoveryHistory(
    recoverySinceMs,
    listUpdateRuns({ limit: 100 }, options),
  );
  if (
    currentRuns.some(needsPostCoreRepair) ||
    currentHistory.postCoreRuns.length > 0 ||
    currentHistory.incomplete
  ) {
    throw new Error(
      `Update history changed during inspection and now needs post-core maintenance. Retry ${formatCliCommand("openclaw update repair", env)}; if the managed Gateway cannot stop, run ${formatCliCommand("openclaw gateway stop", env)} first.`,
    );
  }
  const reconciled = activeRuns.length
    ? await reconcileAbandonedUpdateRunsAsync(
        {
          explicit: true,
          runIds: activeRuns.map((run) => run.runId),
          requireAllActive: true,
          repairHistorySinceMs: recoverySinceMs,
        },
        options,
      )
    : [];
  if (listUpdateRuns({ active: true, limit: 1 }, options).length) {
    throw new Error("An update is still in progress; retry update repair after it finishes.");
  }
  const acknowledged = recoveryRunIds.filter((runId) =>
    acknowledgeAbandonedUpdateRun(runId, options),
  );
  const message = reconciled.length
    ? `Gateway is healthy. Reconciled ${reconciled.length} abandoned update run${reconciled.length === 1 ? "" : "s"}. No maintenance or service restart was needed.`
    : "Gateway is healthy. Abandoned update runs are already reconciled. No maintenance or service restart was needed.";
  const warnings = getGatewayChannelWarnings(gateway, http).map(({ id }) => id);
  reportRepairResult(
    opts,
    acknowledged,
    message +
      (warnings.length
        ? ` Channel health warnings: ${warnings.join(", ")}. Run openclaw channels status --probe.`
        : ""),
    retained,
  );
}

function reportRepairResult(
  opts: UpdateFinalizeOptions,
  reconciledRuns: string[],
  message: string,
  retained?: RetainedUpdateCustodyReport,
): void {
  if (opts.json) {
    defaultRuntime.writeJson({
      status: retained ? "warning" : "ok",
      coreUpdate: (retained ? "pending" : "completed") satisfies UpdateCoreCompletion,
      mode: "repair",
      restart: false,
      reconciledRuns,
      message,
      ...retained,
    });
  } else {
    defaultRuntime.log(message);
    if (retained) {
      defaultRuntime.log(theme.warn(retained.nextAction));
    }
  }
  if (retained) {
    exitCliAfterOutput(defaultRuntime, 2);
  }
}
