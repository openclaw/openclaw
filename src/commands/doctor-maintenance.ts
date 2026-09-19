/** Coordinates explicit Doctor repair with the managed Gateway lifecycle. */
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-maintenance.js";
import { isDefaultInstallIdentity, resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ServiceInspectionError } from "../daemon/service-inspection-error.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import { assertLegacyGatewayStoppedForMaintenance } from "../infra/gateway-lock-legacy.js";
import { readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import { readGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import {
  acquireGatewayMaintenanceCoordinator,
  acquireStateDatabaseCoordinator,
} from "../infra/state-database-coordinator.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import { UpdateDoctorError } from "../infra/update-doctor-result.js";
import { inspectUpdateRepairDriverAdmission } from "../infra/update-run-activity.js";
import { listUpdateRuns, recordUpdateRunRepairContinuation } from "../infra/update-run-ledger.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  assertStaleDoctorGatewayStopped,
  doctorGatewayMaintenanceError,
  inspectStaleDoctorGateway,
  type DoctorStaleGateway,
} from "./doctor-maintenance-stale-service.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import { isDoctorUpdateRepairMode, resolveDoctorRepairMode } from "./doctor-repair-mode.js";
import {
  isServiceRepairExternallyManaged,
  resolveUpdateParentGatewayActivation,
  shouldManageGatewayService,
} from "./doctor-service-repair-policy.js";
import {
  recordUpdateDoctorRefusal,
  resolveUpdateDoctorGitRecovery,
} from "./doctor-update-refusal.js";

function assertDoctorServiceSelection(env: NodeJS.ProcessEnv, serviceEnv: NodeJS.ProcessEnv): void {
  const selection = (candidate: NodeJS.ProcessEnv) => {
    const stateDir = resolveStateDir(candidate);
    return [stateDir, resolveConfigPath(candidate, stateDir)].map((value) =>
      resolvePathViaExistingAncestorSync(value),
    );
  };
  const before = selection(env);
  if (selection(serviceEnv).some((value, index) => value !== before[index])) {
    throw new Error(
      "Doctor and the managed Gateway select different config or state directories. Run doctor with the Gateway's installation and profile; the service was left unchanged.",
    );
  }
}

function assertDoctorMaintenanceInspection(
  inspection: PreManagedServiceStop,
  env: NodeJS.ProcessEnv,
): void {
  const kind = inspection.serviceUpdateVerdict?.kind;
  // Unavailable inspection grants no service authority. The state coordinators
  // and agent leases below still exclude live writers before repair.
  if (
    !inspection.blockMessage &&
    (kind === "unavailable" ||
      (inspection.inspected &&
        (kind === "owned" || kind === "absent" || inspection.offline === true)))
  ) {
    return;
  }
  throw new Error(
    inspection.blockMessage ??
      `Gateway service ownership or shutdown could not be verified. Run ${formatCliCommand("openclaw gateway status --deep", env)} and stop it through its service owner before retrying.`,
  );
}

export async function beginDoctorMaintenance(params: {
  options: DoctorOptions;
  root: string | null;
  runtime: RuntimeEnv;
  runId?: string;
}): Promise<
  | {
      run<T>(operation: () => T): T;
      releaseState(): Promise<void>;
      release(): Promise<void>;
      finish(cfg: OpenClawConfig): Promise<void>;
      warnings?: string[];
    }
  | undefined
> {
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
  let serviceMaintenance:
    | typeof import("../cli/update-cli/update-command-service-maintenance.js")
    | undefined;
  const coordinators: Array<{ release(): void }> = [];
  const warnings: string[] = [];
  let repairStoresMayBeOpen = false;
  let resources: OpenClawDatabaseMaintenanceScope | undefined;
  let inspectingActivation = false;
  let parentMustStopGateway = false;
  let staleReplacement: DoctorStaleGateway | undefined;
  let assertUpdateAdmissionCurrent: (() => void) | undefined;
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
  const databasePath = path.resolve(resolveOpenClawStateSqlitePath(env));
  const acquireMaintenanceResources = () => {
    if (resources) {
      return;
    }
    const owner = acquireGatewayMaintenanceCoordinator({ databasePath, busyTimeoutMs: 0 });
    coordinators.push(owner);
    resources = createOpenClawDatabaseMaintenanceScope(owner.createSchemaFenceDelegate);
    coordinators.push(acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 250 }));
  };
  const releaseState = async () => {
    if (cleanupFailure) {
      throw cleanupFailure.error;
    }
    if (repairStoresMayBeOpen) {
      await resources?.close();
      repairStoresMayBeOpen = false;
    }
    for (const coordinator of coordinators.splice(0).toReversed()) {
      coordinator.release();
    }
  };
  const release = async (assertCustody?: () => void) => {
    await settle(async () => {
      await releaseState();
      assertCustody?.();
      const recovery = stopped?.windowsTaskAutoStartRecovery;
      try {
        await settle(async () => {
          await serviceMaintenance?.maybeResumeWindowsTaskAutoStartAfterPackageUpdate(stopped);
        });
      } finally {
        if (!cleanupFailure) {
          await settle(async () => {
            await recovery?.complete();
          });
        }
      }
    });
  };
  const finish = async (cfg: OpenClawConfig, assertCustody?: () => void) => {
    await release(assertCustody);
    assertCustody?.();
    const before = stopped;
    const root = params.root;
    if (!before?.stopped || !before.serviceEnv || !root) {
      return;
    }
    try {
      const serviceEnv = before.serviceEnv;
      const [
        { readGatewayServiceState, resolveGatewayService },
        { withGatewayServiceOperationLock },
        { resolveUpdatedGatewayRestartPort },
        { renderRestartDiagnostics, waitForGatewayHealthyRestart },
        { revalidateManagedGatewayServiceAfterUpdate },
      ] = await Promise.all([
        import("../daemon/service.js"),
        import("../daemon/service-operation-lock.js"),
        import("../cli/update-cli/update-command-service-plan.js"),
        import("../cli/daemon-cli/restart-health.js"),
        import("../cli/update-cli/update-command-service-maintenance.js"),
      ]);
      const service = resolveGatewayService();
      const state = await withGatewayServiceOperationLock(serviceEnv, async (assertCurrent) => {
        const assertInspectionCurrent = () => {
          assertCustody?.();
          assertCurrent();
        };
        const assertMaintenanceCurrent = () => {
          assertInspectionCurrent();
          assertUpdateAdmissionCurrent?.();
        };
        assertMaintenanceCurrent();
        let current: Awaited<ReturnType<typeof readGatewayServiceState>> | undefined;
        let inspectionFailure: unknown;
        try {
          current = await settle(() =>
            readGatewayServiceState(service, {
              env: serviceEnv,
              requireEffective: true,
              requireLoadedCommand: true,
              // LoadUnit only loads metadata. Keep live custody here; fresh update
              // admission surrounds inspection and activation, outside the read budget.
              ...(process.platform === "linux" && before.serviceManagerUid !== undefined
                ? {
                    loadForInspection: {
                      managerUid: before.serviceManagerUid,
                      assertCurrent: assertInspectionCurrent,
                    },
                  }
                : {}),
            }),
          );
          if (current.inspectionReason) {
            inspectionFailure = new ServiceInspectionError(current.inspectionReason);
          } else if (
            current.loadState.status === "unknown" ||
            (current.runtime?.status !== "running" && current.runtime?.status !== "stopped")
          ) {
            inspectionFailure = new Error(
              current.loadState.status === "unknown"
                ? current.loadState.detail
                : (current.runtime?.inspectionFailure?.detail ??
                    "Gateway runtime inspection was inconclusive."),
            );
          }
        } catch (error) {
          if (hasCommandProcessCleanupError(error)) {
            throw error;
          }
          inspectionFailure = error;
        }
        assertMaintenanceCurrent();
        if (current) {
          assertDoctorServiceSelection(env, current.env);
          const inspected = current;
          const verdict = await settle(() =>
            revalidateManagedGatewayServiceAfterUpdate({
              state: inspected,
              root,
              preManagedServiceStop: before,
              allowIncompleteInspection: true,
            }),
          );
          if (verdict.kind === "unavailable") {
            inspectionFailure ??= new Error(verdict.message);
          }
        }
        if (inspectionFailure) {
          const warning = `Warning: Gateway restoration inspection was inconclusive: ${formatErrorMessage(inspectionFailure)} Starting the managed Gateway stopped by Doctor and verifying readiness.`;
          warnings.push(warning);
          params.runtime.log(warning);
        }
        assertMaintenanceCurrent();
        const restore = current && !inspectionFailure ? service.restart : service.start;
        await settle(async () => {
          await restore({
            env: current?.env ?? serviceEnv,
            stdout: params.options.json ? process.stderr : process.stdout,
            preserveDefinition: true,
            assertCurrent: assertMaintenanceCurrent,
          });
        });
        assertMaintenanceCurrent();
        return current ?? { env: serviceEnv, command: null };
      });
      const port = await resolveUpdatedGatewayRestartPort({
        config: cfg,
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
      if (health.waitOutcome === "still-starting") {
        const warning = renderRestartDiagnostics(health).join(" ");
        warnings.push(warning);
        params.runtime.log(warning);
        return;
      }
      if (!health.healthy) {
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
      if (error instanceof UpdateDoctorError) {
        throw error;
      }
      throw doctorGatewayMaintenanceError({
        env,
        phase: "gateway-restoration",
        code: "doctor-gateway-restoration-failed",
        detail: `The managed Gateway could not be restored after Doctor maintenance: ${String(error)}`,
        cause: error,
      });
    }
    params.runtime.log("Gateway restarted and verified after Doctor repair.");
    if (staleReplacement) {
      const warning = `Warning: Replaced stale Gateway PID ${staleReplacement.pid ?? "unknown"} through its service manager; verified ${staleReplacement.version} build ${staleReplacement.buildId} after Doctor maintenance.`;
      warnings.push(warning);
      params.runtime.log(warning);
    }
  };
  try {
    await settle(async () => {
      if (
        params.root &&
        isDefaultInstallIdentity(env) &&
        !isServiceRepairExternallyManaged() &&
        (await shouldManageGatewayService(env))
      ) {
        serviceMaintenance =
          await import("../cli/update-cli/update-command-service-maintenance.js");
        const { maybeStopManagedServiceBeforeMutableUpdate } = serviceMaintenance;
        inspectingActivation = true;
        const inspection = await maybeStopManagedServiceBeforeMutableUpdate({
          updateInstallKind: "package",
          root: params.root,
          shouldRestart: true,
          jsonMode: true,
          phase: "inspect",
        });
        assertDoctorMaintenanceInspection(inspection, env);
        if (inspection.serviceUpdateVerdict?.kind !== "absent" && inspection.offline !== true) {
          const inheritedRunId = env[UPDATE_RUN_ID_ENV]?.trim();
          const readAdmission = () => {
            const runs = listUpdateRuns(
              { active: true, limit: 100, includeRunId: inheritedRunId },
              { env },
              openDoctorStateSchemaReadAdmission,
            );
            const admission = inspectUpdateRepairDriverAdmission(runs, inheritedRunId);
            if (admission.kind === "conflict") {
              throw new Error(admission.message);
            }
            return admission;
          };
          const admission = readAdmission();
          assertUpdateAdmissionCurrent = () => {
            readAdmission();
          };
          const continuation =
            admission.kind === "continuation"
              ? admission.run
              : admission.runs.find((run) => run.runId === inheritedRunId);
          if (continuation?.steps.some((step) => step.step === "finalize:repair-continuation")) {
            assertUpdateAdmissionCurrent = () => {
              readAdmission();
              recordUpdateRunRepairContinuation(continuation.runId, inheritedRunId, { env });
            };
          }
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
          parentMustStopGateway = true;
          throw new Error(
            "The update parent must stop the managed Gateway before Doctor maintenance; Doctor left the service unchanged.",
          );
        }
        try {
          acquireMaintenanceResources();
        } catch (error) {
          // A running managed Gateway legitimately owns this coordinator until its
          // service is stopped. Any other holder is knowable before that mutation.
          const gatewayOwner = readGatewayOwnerLease({
            env,
            current: true,
            openStateSchemaReadAdmission: openDoctorStateSchemaReadAdmission,
          });
          const legacyGatewayLock = gatewayOwner
            ? undefined
            : await readActiveGatewayLockIdentity({
                env: inspection.serviceEnv ?? env,
                requireInspection: true,
              });
          if (
            !inspection.running ||
            !(
              (gatewayOwner?.state === "live" && gatewayOwner.mode === "supervised") ||
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
            inspection.serviceUpdateVerdict.refreshDefinition = false;
            try {
              stopped = await maybeStopManagedServiceBeforeMutableUpdate({
                updateInstallKind: "package",
                root: params.root,
                shouldRestart: true,
                jsonMode: true,
                expectedService: inspection,
                assertCurrent: assertUpdateAdmissionCurrent,
                onStopped: (before) => {
                  stopped = before;
                },
              });
              assertDoctorMaintenanceInspection(stopped, env);
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
          }
        } else if (inspection.serviceUpdateVerdict?.kind === "unavailable") {
          warnings.push(inspection.serviceUpdateVerdict.message);
          params.runtime.log(inspection.serviceUpdateVerdict.message);
        } else if (inspection.serviceUpdateVerdict?.kind !== "absent") {
          params.runtime.log(
            "The stopped Gateway service was left unchanged; repairing Doctor's selected state only.",
          );
        }
      }
      inspectingActivation = false;
      await assertLegacyGatewayStoppedForMaintenance(env);
      // Hold the reentrant lifecycle coordinators, not an in-tree Gateway lock:
      // individual migrations acquire their own in-tree locks under this scope.
      // Gateway ownership lasts until that process stops, not for a short transaction.
      acquireMaintenanceResources();
      const { assertNoOpenClawAgentDatabaseLeasesReadOnly, OpenClawAgentDatabaseLeaseActiveError } =
        await import("../state/openclaw-agent-db-lease.js");
      try {
        assertNoOpenClawAgentDatabaseLeasesReadOnly({ env }, openDoctorStateSchemaReadAdmission);
      } catch (error) {
        if (error instanceof OpenClawAgentDatabaseLeaseActiveError) {
          throw error;
        }
        // Classify unreadable state under the held owners without opening a writer.
        const { preflightOpenClawDatabaseSchemas } =
          await import("../state/openclaw-database-preflight.js");
        const schemas = await preflightOpenClawDatabaseSchemas({
          env,
          scope: "state",
          openStateSchemaReadAdmission: openDoctorStateSchemaReadAdmission,
        });
        const unreadable = schemas.indeterminate.find((database) => database.kind === "state");
        if (unreadable) {
          throw new DoctorUnreadableStateDatabaseError(unreadable.path, unreadable.reason);
        }
        throw error;
      }
      repairStoresMayBeOpen = true;
    });
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    try {
      // Discovery has not run yet; restore a service parked before admission failed.
      if (stopped?.stopped) {
        const { readConfigFileSnapshot } = await import("../config/config.js");
        await finish((await readConfigFileSnapshot({ skipPluginValidation: true })).config);
      } else {
        await release();
      }
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `${String(error)} ${String(restoreError)}`, {
        cause: restoreError,
      });
    }
    if (error instanceof DoctorUnreadableStateDatabaseError) {
      throw error;
    }
    if (error instanceof UpdateDoctorError) {
      throw error;
    }
    const refusal = new Error(
      `Doctor could not enter maintenance. ${String(error)}${parentMustStopGateway ? "" : ` Stop the Gateway service and other OpenClaw processes using this state, then run ${formatCliCommand("openclaw doctor --fix", env)} from an independent shell.`}`,
      { cause: error },
    );
    const recovery = inspectingActivation
      ? await resolveUpdateDoctorGitRecovery({ root: params.root })
      : undefined;
    if (recovery) {
      refusal.message += `\n${recovery.message}`;
      recordUpdateDoctorRefusal(refusal.message);
    }
    throw refusal;
  }
  let custody: "held" | "restoring" | "released" = "held";
  const maintenance = {
    warnings,
    run: <T>(operation: () => T) => resources!.run(operation),
    releaseState: () => settle(releaseState),
    async release() {
      if (this !== maintenance) {
        throw new Error("Gateway restoration requires its original live maintenance owner.");
      }
      custody = "released";
      await release();
    },
    async finish(cfg: OpenClawConfig) {
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
      try {
        await finish(cfg, assertCustody);
      } finally {
        custody = "released";
      }
    },
  };
  return maintenance;
}
