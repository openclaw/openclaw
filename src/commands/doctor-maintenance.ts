/** Coordinates explicit Doctor repair with the managed Gateway lifecycle. */
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-maintenance.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ServiceInspectionError,
  findServiceOwnershipRefusal,
  hasGatewayServiceStopUnsafeError,
} from "../daemon/service-inspection-error.js";
import { GatewayServiceAuthorityError } from "../daemon/service-update-authority.js";
import { formatErrorMessage } from "../infra/errors.js";
import { assertLegacyGatewayStoppedForMaintenance } from "../infra/gateway-lock-legacy.js";
import { readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import { readGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import { UpdateDoctorError } from "../infra/update-doctor-result.js";
import { createUpdateFailureFact, type UpdateFailureFact } from "../infra/update-failure-facts.js";
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
  assertDoctorAgentLeaseAdmission,
  preflightExternalDoctorAgentLease,
} from "./doctor-agent-lease-refusal.js";
import { resolveDoctorUpdateAdmission } from "./doctor-maintenance-admission.js";
import { acquireDoctorGatewayMaintenanceCoordinator } from "./doctor-maintenance-foreground.js";
import { assertDoctorMaintenanceInspection } from "./doctor-maintenance-inspection.js";
import {
  assertStaleDoctorGatewayStopped,
  doctorGatewayMaintenanceError,
  inspectStaleDoctorGateway,
  type DoctorStaleGateway,
} from "./doctor-maintenance-stale-service.js";
import type { DoctorOptions } from "./doctor-prompter.js";
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

type DoctorConfigWriter = (nextConfig: OpenClawConfig) => Promise<OpenClawConfig>;

export async function beginDoctorMaintenance(params: {
  options: DoctorOptions;
  root: string | null;
  runtime: RuntimeEnv;
  runId?: string;
  assertCurrent?: () => void;
}): Promise<
  | {
      run<T>(operation: () => T): T;
      releaseState(): Promise<void>;
      release(): Promise<void>;
      finish(cfg: OpenClawConfig, writeConfig?: DoctorConfigWriter): Promise<void>;
      warnings?: string[];
      failureFacts?: UpdateFailureFact[];
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
  const failureFacts: UpdateFailureFact[] = [];
  let repairStoresMayBeOpen = false;
  // Service safety outlives database handles released for an update child.
  let retainStoppedInstallation = false;
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
  const acquireMaintenanceResources = async () => {
    if (resources) {
      return;
    }
    params.assertCurrent?.();
    const owner = await acquireDoctorGatewayMaintenanceCoordinator(databasePath, env, params);
    coordinators.push(owner);
    params.assertCurrent?.();
    resources = createOpenClawDatabaseMaintenanceScope(
      owner.createSchemaFenceDelegate,
      params.assertCurrent,
    );
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
        if (!retainStoppedInstallation) {
          await settle(async () => {
            await serviceMaintenance?.maybeResumeWindowsTaskAutoStartAfterPackageUpdate(
              stopped,
              true,
            );
          });
        }
      } finally {
        if (!cleanupFailure) {
          await settle(async () => {
            await recovery?.complete(!retainStoppedInstallation);
          });
        }
      }
    });
  };
  const finish = async (
    initialConfig: OpenClawConfig,
    assertCustody?: () => void,
    writeConfig?: DoctorConfigWriter,
  ) => {
    let cfg = initialConfig;
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
          warnings.push(message);
          params.runtime.log(message);
        }
      }
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
        const readCurrent = () =>
          settle(() =>
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
        let current: Awaited<ReturnType<typeof readGatewayServiceState>> | undefined;
        let inspectionFailure: unknown;
        try {
          current = await readCurrent();
          if (current.inspectionReason) {
            inspectionFailure = new ServiceInspectionError(current.inspectionReason);
            const refusal = findServiceOwnershipRefusal(inspectionFailure);
            if (refusal) {
              throw refusal;
            }
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
          const refusal = findServiceOwnershipRefusal(error);
          if (refusal) {
            throw refusal;
          }
          inspectionFailure = error;
        }
        assertMaintenanceCurrent();
        let installation = before.serviceUpdateVerdict;
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
          } else {
            installation = verdict;
          }
        }
        if (installation?.kind === "owned" && installation.requiresInstallRootRefresh) {
          if (!inspectionFailure) {
            const [{ maybeRepairGatewayServiceConfig }, { createDoctorPrompter }] =
              await Promise.all([
                import("./doctor-gateway-services.js"),
                import("./doctor-prompter.js"),
              ]);
            cfg = await settle(() =>
              maybeRepairGatewayServiceConfig(
                cfg,
                "local",
                params.runtime,
                createDoctorPrompter({ runtime: params.runtime, options: params.options }),
                {
                  async writeConfig(nextConfig) {
                    assertMaintenanceCurrent();
                    // Failed maintenance entry has no inspected Doctor writer context.
                    // Do not fall back to an independent config replacement on recovery.
                    if (!writeConfig) {
                      throw new Error(
                        "Doctor config writer is unavailable during service restoration.",
                      );
                    }
                    const committed = await writeConfig(nextConfig);
                    assertMaintenanceCurrent();
                    return committed;
                  },
                  serviceMaintenance: {
                    managerUid: before.serviceManagerUid,
                    assertCurrent: assertMaintenanceCurrent,
                    assertReadCurrent: assertInspectionCurrent,
                  },
                },
              ),
            );
            assertMaintenanceCurrent();
            const repairedState = await readCurrent();
            assertMaintenanceCurrent();
            assertDoctorServiceSelection(env, repairedState.env);
            const repaired = await settle(() =>
              revalidateManagedGatewayServiceAfterUpdate({
                state: repairedState,
                root,
                preManagedServiceStop: before,
              }),
            );
            assertMaintenanceCurrent();
            if (repaired.kind === "owned" && !repaired.requiresInstallRootRefresh) {
              return repairedState;
            }
          }
          const message = `Gateway service still targets ${installation.root}; Doctor could not reconcile it with ${root}. The previous installation remains stopped because state compatibility is unverified. Run ${formatCliCommand("openclaw gateway install --force", env)} from the intended install.`;
          warnings.push(message);
          params.runtime.log(message);
          return undefined;
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
            ...(before.serviceSystemdIdentity
              ? { systemdIdentity: before.serviceSystemdIdentity }
              : {}),
          });
        });
        assertMaintenanceCurrent();
        return current ?? { env: serviceEnv, command: null };
      });
      if (!state) {
        return;
      }
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
      warnings.push(warning);
      params.runtime.log(warning);
    }
  };
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
          assertUpdateAdmissionCurrent = resolveDoctorUpdateAdmission(env);
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
          throw new Error(await formatUpdateDoctorServiceStopRefusal(inspection.serviceEnv ?? env));
        }
        try {
          await acquireMaintenanceResources();
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
            inspection.serviceUpdateVerdict.refreshDefinition =
              inspection.serviceUpdateVerdict.requiresInstallRootRefresh === true;
            try {
              stopped = await maybeStopManagedServiceBeforeMutableUpdate({
                updateInstallKind: "package",
                root: params.root,
                shouldRestart: true,
                jsonMode: true,
                expectedService: inspection,
                retainNativeIdentity: true,
                assertCurrent: assertUpdateAdmissionCurrent,
                warn: (message) => {
                  warnings.push(message);
                  params.runtime.log(message);
                },
                onStopped: (before) => {
                  stopped = before;
                },
              });
              assertDoctorMaintenanceInspection(stopped, env);
              if (stopped.serviceUpdateVerdict?.kind === "unavailable") {
                warnings.push(stopped.serviceUpdateVerdict.message);
                params.runtime.log(stopped.serviceUpdateVerdict.message);
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
      await acquireMaintenanceResources();
      await assertDoctorAgentLeaseAdmission(env);
      stopped?.windowsTaskAutoStartRecovery?.beginMutation();
      retainStoppedInstallation =
        stopped?.serviceUpdateVerdict?.kind === "owned" &&
        stopped.serviceUpdateVerdict.requiresInstallRootRefresh === true;
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
      `Doctor could not enter maintenance. ${String(error)}${parentMustStopGateway || hasGatewayServiceStopUnsafeError(error) ? "" : ` Stop the Gateway service and other OpenClaw processes using this state, then run ${formatCliCommand("openclaw doctor --fix", env)} from an independent shell.`}`,
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
    failureFacts,
    run: <T>(operation: () => T) => resources!.run(operation),
    releaseState: () => settle(releaseState),
    async release() {
      if (this !== maintenance) {
        throw new Error("Gateway restoration requires its original live maintenance owner.");
      }
      custody = "released";
      await release();
    },
    async finish(cfg: OpenClawConfig, writeConfig?: DoctorConfigWriter) {
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
        await finish(cfg, assertCustody, writeConfig);
      } finally {
        custody = "released";
      }
    },
  };
  return maintenance;
}
