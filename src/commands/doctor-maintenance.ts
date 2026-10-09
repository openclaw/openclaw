import { formatCliCommand } from "../cli/command-format.js";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-maintenance.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  findServiceOwnershipRefusal,
  hasGatewayServiceStopUnsafeError,
} from "../daemon/service-inspection-error.js";
import { GatewayServiceAuthorityError } from "../daemon/service-update-authority.js";
import { acquireWithWait } from "../infra/acquire-with-wait.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatGatewayLockFailure } from "../infra/gateway-lock-diagnostics.js";
import { assertLegacyGatewayStoppedForMaintenance } from "../infra/gateway-lock-legacy.js";
import { GatewayLockError, readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { GatewayStateOwnerContentionError } from "../infra/gateway-state-owner.js";
import { findStartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import type { AgentDatabaseMigrationTarget } from "../infra/state-migrations.media-persistence-targets.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import { DoctorMaintenanceRefusalError, UpdateDoctorError } from "../infra/update-doctor-result.js";
import { createUpdateFailureFact, type UpdateFailureFact } from "../infra/update-failure-facts.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { resolveCommandProcessSignal, withCommandProcessScope } from "../process/exec-spawn.js";
import {
  assertDoctorAgentLeaseAdmission,
  preflightExternalDoctorAgentLease,
} from "./doctor-agent-lease-refusal.js";
import { resolveDoctorUpdateAdmission } from "./doctor-maintenance-admission.js";
import { holdDoctorMaintenanceExit } from "./doctor-maintenance-exit.js";
import {
  assertDoctorMaintenanceInspection,
  classifyDoctorMaintenanceRefusal,
  readDoctorGatewayOwnerLease,
} from "./doctor-maintenance-inspection.js";
import {
  assertStaleDoctorGatewayStopped,
  doctorGatewayMaintenanceError,
  inspectStaleDoctorGateway,
  type DoctorStaleGateway,
} from "./doctor-maintenance-stale-service.js";
import { createDoctorMaintenanceState } from "./doctor-maintenance-state.js";
import type { DoctorConfigWriter, DoctorMaintenanceParams } from "./doctor-maintenance-types.js";
import { isDoctorUpdateRepairMode, resolveDoctorRepairMode } from "./doctor-repair-mode.js";
import {
  assertDoctorServiceSelection,
  isServiceRepairExternallyManaged,
  resolveUpdateParentGatewayActivation,
  shouldManageGatewayService,
} from "./doctor-service-repair-policy.js";
import {
  formatUpdateDoctorServiceStopRefusal,
  recordUpdateDoctorRefusal,
  resolveUpdateDoctorGitRecovery,
} from "./doctor-update-refusal.js";

export async function beginDoctorMaintenance(params: DoctorMaintenanceParams) {
  if (!(params.options.repair === true || params.options.yes === true)) {
    return undefined;
  }
  const env = { ...process.env, ...(params.runId ? { [UPDATE_RUN_ID_ENV]: params.runId } : {}) };
  // Ordinary activation remains with the parent. Stale-instance recovery below
  // retains custody through offline repair and verified restoration.
  const parentActivation = isDoctorUpdateRepairMode(resolveDoctorRepairMode(params.options))
    ? resolveUpdateParentGatewayActivation(env)
    : undefined;
  // Repair discovery can execute plugins and open writable state. Establish
  // ownership for every explicit repair before running those inspections.
  let stopped: PreManagedServiceStop | undefined;
  let serviceUpdateVerdict: PreManagedServiceStop["serviceUpdateVerdict"];
  let stopDeadline: number | undefined;
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    params.runtime.log(message);
  };
  const failureFacts: UpdateFailureFact[] = [];
  let repairStoresMayBeOpen = false;
  // Service safety outlives database handles released for an update child.
  let retainStoppedInstallation = false;
  let inspectingActivation = false;
  let staleReplacement: DoctorStaleGateway | undefined;
  let assertUpdateAdmissionReadCurrent: (() => void) | undefined;
  let assertUpdateAdmissionCurrent: (() => void) | undefined;
  let authorityRefused = false;
  const assertAuthority = (assertion: () => void) => {
    try {
      assertion();
    } catch (error) {
      authorityRefused = true;
      throw error;
    }
  };
  const callerAssertCurrent = params.assertCurrent;
  const assertCallerCurrent = callerAssertCurrent
    ? () => assertAuthority(callerAssertCurrent)
    : undefined;
  let cleanupFailure: { error: unknown } | undefined;
  const settle = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (cleanupFailure) {
      throw cleanupFailure.error;
    }
    try {
      return await withCommandProcessScope(operation);
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        // Later caller cleanup cannot resume autostart after an uncertain native effect.
        cleanupFailure ??= { error };
      }
      throw error;
    }
  };
  const acquireStoppedMaintenanceResources = () =>
    acquireWithWait({
      acquire: () => state.acquire(),
      shouldRetry: (error) =>
        stopped?.stopped === true && error instanceof GatewayStateOwnerContentionError,
      deadlineMs: stopDeadline ?? performance.now(),
      pollIntervalMs: 250,
      maxPollIntervalMs: 2_000,
    });
  const releaseState = async () => {
    if (cleanupFailure) {
      throw cleanupFailure.error;
    }
    await state.release();
    repairStoresMayBeOpen = false;
  };
  const release = async (assertCustody?: () => void) => {
    await settle(async () => {
      await releaseState();
      const recovery = stopped?.windowsTaskAutoStartRecovery;
      try {
        assertCustody?.();
        if (!retainStoppedInstallation) {
          await settle(async () => {
            await recovery?.restore(true);
          });
        }
      } finally {
        if (!cleanupFailure) {
          await settle(async () => recovery?.complete(!retainStoppedInstallation));
        }
      }
    });
  };
  const finish = async (
    cfg: OpenClawConfig,
    assertCustody?: () => void,
    writeConfig?: DoctorConfigWriter,
    assertRestoreAdmission = assertUpdateAdmissionCurrent,
  ) => {
    await release(assertCustody);
    assertCustody?.();
    const before = stopped;
    const root = params.root;
    if (!before?.serviceEnv || !root) {
      return;
    }
    if (!before.stopped) {
      const verdict = before.serviceUpdateVerdict;
      if (verdict?.kind === "owned" && verdict.requiresInstallRootRefresh) {
        const { inspectGatewayServiceInstallationDrift } =
          await import("../daemon/service-layout.js");
        const drift = await inspectGatewayServiceInstallationDrift(
          { packageRootReal: verdict.root },
          root,
        );
        if (drift) {
          const { formatGatewayServiceInstallationDrift } =
            await import("../cli/daemon-cli/shared.js");
          const message = formatGatewayServiceInstallationDrift(
            drift,
            undefined,
            before.serviceEnv,
            {
              stopped: true,
              port: before.servicePort,
            },
          );
          warn(message);
          return;
        }
      }
      if (
        resolveDoctorRepairMode(params.options).updateInProgress ||
        before.offline !== true ||
        verdict?.kind !== "owned" ||
        verdict.requiresInstallRootRefresh
      ) {
        return;
      }
    }
    try {
      const serviceEnv = before.serviceEnv;
      const [
        { restoreDoctorGatewayService },
        { resolveUpdatedGatewayRestartPort },
        { renderRestartDiagnostics, waitForGatewayHealthyRestart },
      ] = await Promise.all([
        import("./doctor-maintenance-restoration.js"),
        import("../cli/update-cli/update-command-service-plan.js"),
        import("../cli/daemon-cli/restart-health.js"),
      ]);
      const {
        service,
        state,
        cfg: restoredConfig,
      } = await restoreDoctorGatewayService({
        before,
        serviceEnv,
        root,
        env,
        cfg,
        writeConfig,
        options: params.options,
        runtime: params.runtime,
        signal: exit.signal,
        warnings,
        settle,
        assertCustody,
        assertRestoreAdmission,
        assertInstallationAdmission: assertUpdateAdmissionCurrent,
      });
      if (!state) {
        return;
      }
      const port = await resolveUpdatedGatewayRestartPort({
        config: restoredConfig,
        serviceEnv: state.env,
        serviceCommand: state.command,
      });
      const health = await settle(() =>
        waitForGatewayHealthyRestart({
          service,
          port,
          env: state.env,
          requireRunningService: true,
          ...(staleReplacement
            ? {
                expectedVersion: staleReplacement.version,
                expectedBuildId: staleReplacement.buildId,
                requirePluginHealth: false,
              }
            : {}),
        }),
      );
      if (
        health.outcome === "starting" ||
        (health.outcome !== "ready" && health.runtime.status === "running")
      ) {
        warn(
          `Warning: Doctor repair complete; Gateway started but readiness was not verified. ${renderRestartDiagnostics(health).join(" ")} Run \`${formatCliCommand("openclaw gateway status --deep", state.env)}\` or \`${formatCliCommand("openclaw gateway diagnostics export", state.env)}\`.`,
        );
        return;
      }
      if (health.outcome !== "ready") {
        throw doctorGatewayMaintenanceError({
          env,
          phase: "gateway-restoration",
          code: "doctor-gateway-rpc-verification-failed",
          detail: `Doctor repaired state, but the managed Gateway did not become ready: ${renderRestartDiagnostics(health).join(" ")}.`,
        });
      }
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        cleanupFailure ??= { error };
        throw error;
      }
      if (error instanceof GatewayServiceAuthorityError) {
        const { formatDaemonServiceInstallCommand } = await import("../cli/daemon-cli/shared.js");
        const serviceEnv = before.serviceEnv;
        const outcome = error.outcome ?? "recovery-pending";
        const recovery =
          outcome === "unchanged"
            ? "The previous service definition was left unchanged."
            : outcome === "restored"
              ? "The previous service definition was restored from its captured backup."
              : "Restoration was not verified; inspect the current service before replacing it.";
        const message = `Doctor could not finish Gateway installation or activation under its maintenance authority (${outcome}). ${recovery} Run \`${formatCliCommand("openclaw gateway status --deep", serviceEnv)}\`; after the active maintenance or update finishes, run \`${formatDaemonServiceInstallCommand(serviceEnv, before.servicePort)}\` from the active CLI. Reason: ${error.message}`;
        failureFacts.push(
          createUpdateFailureFact(
            {
              check: "gateway-restoration",
              code: `${error.code}-${outcome}`,
              message,
            },
            serviceEnv,
          ),
        );
        warnings.push(message);
        params.runtime.error(message);
        if (outcome === "recovery-pending") {
          throw new UpdateDoctorError(message, failureFacts, { cause: error });
        }
        return;
      }
      if (error instanceof UpdateDoctorError) {
        throw error;
      }
      throw doctorGatewayMaintenanceError({
        env,
        phase: "gateway-restoration",
        code: findServiceOwnershipRefusal(error)?.reason ?? "doctor-gateway-restoration-failed",
        detail: `The managed Gateway could not be restored after Doctor maintenance: ${String(error)}`,
        cause: error,
      });
    }
    params.runtime.log("Gateway restarted and verified after Doctor repair.");
    if (staleReplacement) {
      const warning = `Warning: Replaced stale Gateway PID ${staleReplacement.pid ?? "unknown"} through its service manager; verified ${staleReplacement.version} build ${staleReplacement.buildId} after Doctor maintenance.`;
      warn(warning);
    }
  };
  const admitRepair = async () => {
    inspectingActivation = false;
    await assertLegacyGatewayStoppedForMaintenance(state.env);
    // Retain one process owner across every migration and its resource drainage.
    await acquireStoppedMaintenanceResources();
    assertUpdateAdmissionCurrent?.();
    await assertDoctorAgentLeaseAdmission(state.env);
    repairStoresMayBeOpen = true;
  };
  let admissionFailureHandled = false;
  const failAdmission = async (error: unknown, assertStopCustody?: () => void): Promise<never> => {
    admissionFailureHandled = true;
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    try {
      // Discovery has not run yet; restore a service parked before admission failed.
      if (stopped?.stopped) {
        // A native stop can fail after bootout too. Use the same remaining stop
        // budget before restoration, even when admission was never reached.
        try {
          await acquireStoppedMaintenanceResources();
        } catch (ownershipError) {
          const warning =
            ownershipError instanceof GatewayStateOwnerContentionError
              ? `Warning: The stopped Gateway still holds state ownership after the service stop deadline. Shared-state repair is unsafe while that writer remains active. Restoring its service; run ${formatCliCommand("openclaw gateway status --deep", env)}, then retry ${formatCliCommand("openclaw doctor --fix", env)} after shutdown completes.`
              : `Warning: Doctor could not reacquire maintenance ownership: ${String(ownershipError)} Restoring its service without repairing shared state.`;
          warn(warning);
        }
        const { readConfigFileSnapshot } = await import("../config/config.js");
        await finish(
          (await readConfigFileSnapshot({ skipPluginValidation: true, observe: false })).config,
          assertStopCustody,
          undefined,
          assertStopCustody ?? assertUpdateAdmissionCurrent,
        );
      } else {
        await release();
      }
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `${String(error)} ${String(restoreError)}`, {
        cause: restoreError,
      });
    }
    resolveCommandProcessSignal()?.throwIfAborted();
    if (authorityRefused || error instanceof DoctorUnreadableStateDatabaseError) {
      throw error;
    }
    const newerSchema = findStartupMaintenanceRequiredError(error)?.kind === "newer-schema";
    // Released Git drivers consume the original refusal prefix and recovery tail.
    const refusal =
      error instanceof DoctorMaintenanceRefusalError
        ? error
        : new DoctorMaintenanceRefusalError(
            `Doctor could not enter maintenance. ${error instanceof GatewayLockError ? formatGatewayLockFailure(error) : String(error)}${newerSchema || hasGatewayServiceStopUnsafeError(error) ? "" : ` Stop the Gateway service and other OpenClaw processes using this state, then run ${formatCliCommand("openclaw doctor --fix", env)} from an independent shell.`}`,
            classifyDoctorMaintenanceRefusal(error),
            {
              cause: error,
              ...(error instanceof UpdateDoctorError ? { failureFacts: error.failureFacts } : {}),
            },
          );
    const recovery =
      inspectingActivation && !newerSchema
        ? await resolveUpdateDoctorGitRecovery({ root: params.root })
        : undefined;
    if (recovery) {
      refusal.message += `\n${recovery.message}`;
      recordUpdateDoctorRefusal(refusal.message);
    }
    throw refusal;
  };
  // Admission can stop the service before returning a maintenance handle.
  const exit = holdDoctorMaintenanceExit((message) => {
    warnings.push(message);
    params.runtime.error(message);
  });
  const state = await createDoctorMaintenanceState({
    params,
    env,
    signal: exit.signal,
    deadline: () => stopDeadline,
    assertCurrent: assertCallerCurrent,
    assertReadCurrent: () => assertUpdateAdmissionReadCurrent?.(),
    settle,
    warn,
  });
  try {
    await settle(async () => {
      const externallyManaged = isServiceRepairExternallyManaged();
      if (externallyManaged) {
        await preflightExternalDoctorAgentLease(env);
      }
      if (
        params.root &&
        isDefaultInstallIdentity(env) &&
        !externallyManaged &&
        (await shouldManageGatewayService(env))
      ) {
        const { maybeStopManagedServiceBeforeMutableUpdate } =
          await import("../cli/update-cli/update-command-service-maintenance.js");
        inspectingActivation = true;
        const inspection = await maybeStopManagedServiceBeforeMutableUpdate({
          updateInstallKind: "package",
          root: params.root,
          shouldRestart: true,
          jsonMode: true,
          phase: "inspect",
        });
        assertDoctorMaintenanceInspection(inspection, env);
        serviceUpdateVerdict = inspection.serviceUpdateVerdict;
        if (inspection.serviceUpdateVerdict?.kind !== "absent" && inspection.offline !== true) {
          assertAuthority(() => {
            const admitted = resolveDoctorUpdateAdmission(env);
            // Storage guards can run inside a transaction; receipts belong to service admission.
            assertUpdateAdmissionReadCurrent = () => assertAuthority(admitted.assertCurrent);
            const checkAndRecord = () => assertAuthority(admitted.recordContinuation);
            assertUpdateAdmissionCurrent = () =>
              state.owner ? state.owner.run(checkAndRecord) : checkAndRecord();
          });
        }
        if (inspection.serviceUpdateVerdict?.kind === "owned" && inspection.serviceEnv) {
          assertDoctorServiceSelection(env, inspection.serviceEnv);
        }
        staleReplacement = await inspectStaleDoctorGateway({
          root: params.root,
          env,
          before: inspection,
          assertCurrent: assertUpdateAdmissionCurrent,
        });
        if (
          parentActivation !== undefined &&
          !staleReplacement &&
          inspection.serviceUpdateVerdict?.kind === "owned" &&
          inspection.offline !== true
        ) {
          throw new DoctorMaintenanceRefusalError(
            `Doctor could not enter maintenance. Error: ${await formatUpdateDoctorServiceStopRefusal(inspection.serviceEnv ?? env)}`,
            { kind: "data-at-risk", reason: "gateway-state-unverified" },
          );
        }
        try {
          await state.acquire();
        } catch (error) {
          if (hasCommandProcessCleanupError(error)) {
            throw error;
          }
          // A running managed Gateway legitimately owns this state until its
          // service is stopped. Any other holder is knowable before that mutation.
          const observationSignal = resolveCommandProcessSignal(exit.signal) ?? exit.signal;
          const servingOwner = await readDoctorGatewayOwnerLease(state.env, observationSignal);
          const legacyGatewayLock = servingOwner
            ? undefined
            : await readActiveGatewayLockIdentity({
                env: inspection.serviceEnv ?? env,
                requireInspection: true,
              });
          observationSignal.throwIfAborted();
          assertCallerCurrent?.();
          assertUpdateAdmissionReadCurrent?.();
          if (
            !inspection.running ||
            !(
              (servingOwner?.state === "live" && servingOwner.mode === "supervised") ||
              (inspection.servicePid !== undefined &&
                legacyGatewayLock?.pid === inspection.servicePid)
            )
          ) {
            throw error;
          }
        }
        if (inspection.serviceUpdateVerdict?.kind === "owned") {
          inspectingActivation = false;
          if (inspection.serviceEnv) {
            assertDoctorServiceSelection(env, inspection.serviceEnv);
          }
          // Even an owning continuation leaves native activation with its parent.
          if (parentActivation === undefined || staleReplacement) {
            inspection.serviceUpdateVerdict.refreshDefinition =
              inspection.serviceUpdateVerdict.requiresInstallRootRefresh === true;
            const root = params.root;
            const { withGatewayServiceOperationLock } =
              await import("../daemon/service-operation-lock.js");
            await withGatewayServiceOperationLock(
              inspection.serviceEnv ?? env,
              async (assertStopCustody) => {
                let assertServiceCurrent = assertUpdateAdmissionCurrent;
                try {
                  await settle(async () => {
                    try {
                      stopDeadline = performance.now() + GATEWAY_SERVICE_STOP_TIMEOUT_MS;
                      const stopService = () =>
                        maybeStopManagedServiceBeforeMutableUpdate({
                          updateInstallKind: "package",
                          root,
                          shouldRestart: true,
                          jsonMode: true,
                          expectedService: inspection,
                          retainNativeIdentity: true,
                          assertCurrent: () => assertServiceCurrent?.(),
                          warn,
                          onStopped: (before) => {
                            stopped = before;
                          },
                        });
                      // The drain's auth probe borrows state custody acquired before stopping.
                      stopped = await (state.resources
                        ? state.resources.run(stopService)
                        : stopService());
                      assertDoctorMaintenanceInspection(stopped, env);
                      if (stopped.serviceUpdateVerdict?.kind === "unavailable") {
                        warn(stopped.serviceUpdateVerdict.message);
                      }
                      if (staleReplacement && stopped.serviceEnv) {
                        await assertStaleDoctorGatewayStopped({
                          stale: staleReplacement,
                          env: stopped.serviceEnv,
                          assertCurrent: assertUpdateAdmissionCurrent,
                        });
                      }
                    } catch (error) {
                      if (!staleReplacement || hasCommandProcessCleanupError(error)) {
                        throw error;
                      }
                      throw doctorGatewayMaintenanceError({
                        env,
                        phase: "gateway-stop",
                        code: "stale-gateway-stop-failed",
                        detail: String(error),
                        cause: error,
                      });
                    }
                    if (stopped?.stopped) {
                      params.runtime.log("Stopped the managed Gateway for Doctor repair.");
                    }
                    await admitRepair();
                    assertStopCustody();
                  });
                } catch (error) {
                  // Recovery handles can retain the stop assertion (Windows autostart).
                  assertServiceCurrent = assertStopCustody;
                  // No repair ran. Reverse only our own stop under its retained
                  // native grant; normal finish still requires update admission.
                  await failAdmission(error, assertStopCustody);
                }
              },
            );
          }
        } else if (inspection.serviceUpdateVerdict?.kind === "unavailable") {
          warn(inspection.serviceUpdateVerdict.message);
        } else if (inspection.serviceUpdateVerdict?.kind !== "absent") {
          params.runtime.log(
            "The stopped Gateway service was left unchanged; repairing Doctor's selected state only.",
          );
        }
      }
      if (!repairStoresMayBeOpen) {
        await admitRepair();
      }
      stopped?.windowsTaskAutoStartRecovery?.beginMutation();
      retainStoppedInstallation =
        stopped?.serviceUpdateVerdict?.kind === "owned" &&
        stopped.serviceUpdateVerdict.requiresInstallRootRefresh === true;
      await state.prepareRepair();
    });
  } catch (error) {
    try {
      if (admissionFailureHandled) {
        throw error;
      }
      await failAdmission(error);
    } finally {
      exit.release(true);
    }
  }
  let custody: "held" | "restoring" | "released" = "held";
  const assertHeld = (receiver: unknown, operation: string) => {
    if (receiver !== maintenance || custody !== "held") {
      throw new Error(`${operation} requires its original live maintenance owner.`);
    }
  };
  const maintenance = {
    signal: exit.signal,
    serviceUpdateVerdict,
    warnings,
    failureFacts,
    get databaseWrites() {
      return state.receipt;
    },
    run: <T>(operation: () => T) => state.run(operation),
    releaseState: () => settle(releaseState),
    async repairSqliteNoCow(paths: readonly string[]) {
      assertHeld(this, "SQLite NOCOW repair");
      const result = await settle(() => state.repairSqliteNoCow(paths));
      for (const message of result.changes) {
        params.runtime.log(message);
      }
      for (const message of result.warnings) {
        warn(message);
      }
    },
    async enableSqliteReclamation(agents: readonly AgentDatabaseMigrationTarget[]) {
      assertHeld(this, "SQLite reclamation");
      const result = await settle(() => state.enableSqliteReclamation(agents));
      for (const message of result.warnings) {
        warn(message);
      }
    },
    async cleanupRetainedRuntimes() {
      assertHeld(this, "Updater runtime cleanup");
      await settle(() => state.cleanupRetainedRuntimes(serviceUpdateVerdict !== undefined));
    },
    async release() {
      if (this !== maintenance) {
        throw new Error("Gateway restoration requires its original live maintenance owner.");
      }
      custody = "released";
      try {
        await release();
      } catch (error) {
        exit.release(true);
        throw error;
      } finally {
        exit.release();
      }
    },
    async finish(
      initialConfig: OpenClawConfig | undefined,
      writeConfig?: DoctorConfigWriter,
      failure?: unknown,
    ) {
      let cfg = initialConfig;
      if (cleanupFailure) {
        throw cleanupFailure.error;
      }
      const assertCustody = (expected: typeof custody = "restoring") => {
        if (this !== maintenance || custody !== expected) {
          throw new Error("Gateway restoration requires its original live maintenance owner.");
        }
      };
      assertCustody("held");
      custody = "restoring";
      let failed = failure !== undefined;
      try {
        if (!cfg && !stopped?.stopped) {
          await release(assertCustody);
          return;
        }
        if (!cfg) {
          try {
            // Readiness may be the operation that failed. Reversing Doctor's own
            // stop must not re-enter that gate; the previous Gateway remains the
            // recovery owner for the persisted state it was already serving.
            const { readConfigFileSnapshot } = await import("../config/config.js");
            cfg = (await readConfigFileSnapshot({ skipPluginValidation: true, observe: false }))
              .config;
          } catch (error) {
            throw new DoctorMaintenanceRefusalError(
              `Doctor could not restore the Gateway because persisted repair state is not ready: ${formatErrorMessage(error)}`,
              { kind: "data-at-risk", reason: "incomplete-migration" },
              { cause: error },
            );
          }
        }
        await finish(cfg, assertCustody, writeConfig);
      } catch (restoreError) {
        failed = true;
        if (failure !== undefined) {
          throw new AggregateError(
            [failure, restoreError],
            `${formatErrorMessage(failure)} ${formatErrorMessage(restoreError)}`,
            { cause: restoreError },
          );
        }
        throw restoreError;
      } finally {
        custody = "released";
        exit.release(failed);
      }
    },
  };
  return maintenance;
}
