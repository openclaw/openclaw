/** Coordinates explicit Doctor repair with the managed Gateway lifecycle. */
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-maintenance.js";
import { isDefaultInstallIdentity, resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import {
  acquireGatewayLifecycleCoordinator,
  acquireStateDatabaseCoordinator,
} from "../infra/state-database-coordinator.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import { inspectUpdateRepairDriverAdmission } from "../infra/update-run-activity.js";
import { listUpdateRuns, recordUpdateRunRepairContinuation } from "../infra/update-run-ledger.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
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
  // Non-owned services grant no stop authority. The native lifecycle owner
  // must prove them offline before Doctor can repair its own selected state.
  if (
    !inspection.blockMessage &&
    inspection.inspected &&
    (kind === "owned" || kind === "absent" || inspection.offline === true)
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
  assertCurrent?: () => void;
}): Promise<{ release(): Promise<void>; finish(cfg: OpenClawConfig): Promise<void> } | undefined> {
  if (!(params.options.repair === true || params.options.yes === true)) {
    return undefined;
  }
  params.assertCurrent?.();
  const env = { ...process.env };
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
  let repairStoresMayBeOpen = false;
  let inspectingActivation = false;
  let assertContinuationCurrent: (() => void) | undefined;
  let assertUpdateAdmissionCurrent: (() => void) | undefined;
  const release = async () => {
    if (repairStoresMayBeOpen) {
      const [{ closeOpenClawAgentDatabasesAsync }, { closeOpenClawStateDatabaseByPathAsync }] =
        await Promise.all([
          import("../state/openclaw-agent-db.js"),
          import("../state/openclaw-state-db.js"),
        ]);
      // Agent handles release leases through shared state. Keep maintenance
      // ownership and retry state until both drains succeed.
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
      repairStoresMayBeOpen = false;
    }
    for (const coordinator of coordinators.splice(0).toReversed()) {
      coordinator.release();
    }
    const recovery = stopped?.windowsTaskAutoStartRecovery;
    try {
      await serviceMaintenance?.maybeResumeWindowsTaskAutoStartAfterPackageUpdate(stopped);
    } finally {
      await recovery?.complete();
    }
  };
  try {
    if (
      params.root &&
      isDefaultInstallIdentity(env) &&
      !isServiceRepairExternallyManaged() &&
      (await shouldManageGatewayService(env))
    ) {
      serviceMaintenance = await import("../cli/update-cli/update-command-service-maintenance.js");
      const { maybeStopManagedServiceBeforeMutableUpdate } = serviceMaintenance;
      inspectingActivation = true;
      const inspection = await maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: "package",
        root: params.root,
        shouldRestart: true,
        jsonMode: true,
        phase: "inspect",
        ...(params.assertCurrent ? { assertCurrent: params.assertCurrent } : {}),
      });
      params.assertCurrent?.();
      assertDoctorMaintenanceInspection(inspection, env);
      if (inspection.serviceUpdateVerdict?.kind !== "absent" && inspection.offline !== true) {
        const inheritedRunId = env[UPDATE_RUN_ID_ENV]?.trim();
        const readAdmission = () => {
          const runs = listUpdateRuns(
            { active: true, limit: 100, includeRunId: inheritedRunId },
            { env },
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
          assertContinuationCurrent = () => {
            readAdmission();
            recordUpdateRunRepairContinuation(continuation.runId, inheritedRunId, { env });
          };
          assertUpdateAdmissionCurrent = assertContinuationCurrent;
        }
      }
      if (
        parentActivation !== undefined &&
        !assertContinuationCurrent &&
        inspection.serviceUpdateVerdict?.kind !== "absent" &&
        inspection.offline !== true
      ) {
        throw new Error(
          "The update parent owns Gateway activation. Stop the service through its owner before retrying the update; Doctor will not stop or restart it.",
        );
      }
      if (inspection.serviceUpdateVerdict?.kind === "owned") {
        inspectingActivation = false;
        if (inspection.serviceEnv) {
          assertDoctorServiceSelection(env, inspection.serviceEnv);
        }
        // Explicit repair continuation may park and restore its own service;
        // ordinary updater finalization leaves activation with the parent.
        if (parentActivation === undefined || assertContinuationCurrent) {
          inspection.serviceUpdateVerdict.refreshDefinition = false;
          stopped = await maybeStopManagedServiceBeforeMutableUpdate({
            updateInstallKind: "package",
            root: params.root,
            shouldRestart: true,
            jsonMode: true,
            expectedService: inspection,
            assertCurrent: params.assertCurrent
              ? () => {
                  params.assertCurrent?.();
                  assertUpdateAdmissionCurrent?.();
                }
              : assertUpdateAdmissionCurrent,
          });
          assertDoctorMaintenanceInspection(stopped, env);
          if (stopped.stopped) {
            params.runtime.log("Stopped the managed Gateway for Doctor repair.");
          }
        }
      } else if (inspection.serviceUpdateVerdict?.kind !== "absent") {
        params.runtime.log(
          "The stopped Gateway service was left unchanged; repairing Doctor's selected state only.",
        );
      }
    }
    inspectingActivation = false;
    const databasePath = path.resolve(resolveOpenClawStateSqlitePath(env));
    // Hold the reentrant lifecycle coordinators, not an in-tree Gateway lock:
    // individual migrations acquire their own in-tree locks under this scope.
    // Gateway ownership lasts until that process stops, not for a short transaction.
    params.assertCurrent?.();
    coordinators.push(acquireGatewayLifecycleCoordinator({ databasePath, busyTimeoutMs: 0 }));
    coordinators.push(acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 250 }));
    const { assertNoOpenClawAgentDatabaseLeasesReadOnly, OpenClawAgentDatabaseLeaseActiveError } =
      await import("../state/openclaw-agent-db-lease.js");
    try {
      params.assertCurrent?.();
      assertNoOpenClawAgentDatabaseLeasesReadOnly({ env });
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
      });
      const unreadable = schemas.indeterminate.find((database) => database.kind === "state");
      if (unreadable) {
        throw new DoctorUnreadableStateDatabaseError(unreadable.path, unreadable.reason);
      }
      throw error;
    }
    repairStoresMayBeOpen = true;
  } catch (error) {
    await release();
    if (error instanceof DoctorUnreadableStateDatabaseError) {
      throw error;
    }
    const refusal = new Error(
      `Doctor could not enter maintenance. ${String(error)} Stop the Gateway service and other OpenClaw processes using this state, then run ${formatCliCommand("openclaw doctor --fix", env)} from an independent shell.`,
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
  return {
    release,
    async finish(cfg) {
      await release();
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
          const assertMaintenanceCurrent = () => {
            assertCurrent();
            assertUpdateAdmissionCurrent?.();
          };
          assertMaintenanceCurrent();
          const current = await readGatewayServiceState(service, {
            env: serviceEnv,
            requireEffective: true,
            requireLoadedCommand: true,
            // A stopped unit may be collected. Reload only its metadata under
            // live custody of the recorded manager, then revalidate the launcher.
            ...(process.platform === "linux" && before.serviceManagerUid !== undefined
              ? {
                  loadForInspection: {
                    managerUid: before.serviceManagerUid,
                    assertCurrent: assertMaintenanceCurrent,
                  },
                }
              : {}),
          });
          assertMaintenanceCurrent();
          assertDoctorServiceSelection(env, current.env);
          await revalidateManagedGatewayServiceAfterUpdate({
            state: current,
            root,
            preManagedServiceStop: before,
          });
          assertMaintenanceCurrent();
          await service.restart({
            env: current.env,
            stdout: process.stdout,
            preserveDefinition: true,
            assertCurrent: assertMaintenanceCurrent,
          });
          assertMaintenanceCurrent();
          return current;
        });
        const port = await resolveUpdatedGatewayRestartPort({
          config: cfg,
          serviceEnv: state.env,
          serviceCommand: state.command,
        });
        const health = await waitForGatewayHealthyRestart({
          service,
          port,
          env: state.env,
          requireRunningService: true,
        });
        if (!health.healthy) {
          throw new Error(
            `Doctor repaired state, but the managed Gateway did not become ready: ${renderRestartDiagnostics(health).join(" ")}. Run ${formatCliCommand("openclaw gateway status --deep", env)}.`,
          );
        }
      } catch (error) {
        throw new Error(
          `Doctor repaired state, but could not restore the managed Gateway: ${String(error)} Run ${formatCliCommand("openclaw gateway status --deep", env)}, then ${formatCliCommand("openclaw gateway restart", env)} after resolving the reported failure.`,
          { cause: error },
        );
      }
      params.runtime.log("Gateway restarted and verified after Doctor repair.");
    },
  };
}
