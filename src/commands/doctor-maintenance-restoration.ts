import { formatCliCommand } from "../cli/command-format.js";
import type { ManagedGatewayUpdateVerdict } from "../cli/update-cli/update-command-service-context-types.js";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-maintenance.js";
import { isManagedGatewayServiceOffline } from "../cli/update-cli/update-command-service-publication.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ServiceInspectionError,
  findServiceOwnershipRefusal,
} from "../daemon/service-inspection-error.js";
import type { GatewayServiceState } from "../daemon/service-types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import { assertDoctorServiceSelection } from "./doctor-service-repair-policy.js";

type StoppedGatewayInspection =
  | { kind: "owned-offline" }
  | { kind: "not-ours"; reason: string }
  | { kind: "inconclusive"; reason: string };

export async function restoreDoctorGatewayService(params: {
  before: PreManagedServiceStop;
  serviceEnv: NodeJS.ProcessEnv;
  root: string;
  env: NodeJS.ProcessEnv;
  cfg: OpenClawConfig;
  writeConfig?: (nextConfig: OpenClawConfig) => Promise<OpenClawConfig>;
  options: DoctorOptions;
  runtime: RuntimeEnv;
  signal: AbortSignal;
  warnings: string[];
  settle: <T>(operation: () => Promise<T>) => Promise<T>;
  assertCustody?: () => void;
  assertRestoreAdmission?: () => void;
  assertInstallationAdmission?: () => void;
}) {
  const {
    before,
    serviceEnv,
    root,
    env,
    writeConfig,
    warnings,
    settle,
    assertCustody,
    assertRestoreAdmission,
  } = params;
  let cfg = params.cfg;
  const [
    { readGatewayServiceState, resolveGatewayService },
    { withGatewayServiceOperationLock },
    { revalidateManagedGatewayServiceAfterUpdate },
  ] = await Promise.all([
    import("../daemon/service.js"),
    import("../daemon/service-operation-lock.js"),
    import("../cli/update-cli/update-command-service-maintenance.js"),
  ]);
  const service = resolveGatewayService();
  const restoredState = await withGatewayServiceOperationLock(serviceEnv, async (assertCurrent) => {
    const assertInspectionCurrent = () => {
      assertCustody?.();
      assertCurrent();
    };
    const assertMaintenanceCurrent = () => {
      assertInspectionCurrent();
      assertRestoreAdmission?.();
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
    const readInspection = async () => {
      current = undefined;
      inspectionFailure = undefined;
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
      return current;
    };
    await readInspection();
    assertMaintenanceCurrent();
    let installation = before.serviceUpdateVerdict;
    const inspectActivation = async (): Promise<StoppedGatewayInspection> => {
      const state = current;
      if (inspectionFailure || !state?.command) {
        return {
          kind: "inconclusive",
          reason: inspectionFailure
            ? formatErrorMessage(inspectionFailure)
            : "The current service launcher could not be verified.",
        };
      }
      if (installation?.kind !== "owned" || installation.requiresInstallRootRefresh) {
        return { kind: "not-ours", reason: "The service does not target this installation." };
      }
      if (state.running || !(await settle(() => isManagedGatewayServiceOffline(state)))) {
        return { kind: "inconclusive", reason: "The service is not verified offline." };
      }
      return { kind: "owned-offline" };
    };
    const mayRestore = async () => {
      if (before.stopped) {
        return true;
      }
      const inspection = await inspectActivation();
      assertMaintenanceCurrent();
      if (inspection.kind === "owned-offline") {
        return true;
      }
      const warning = `Warning: Gateway activation skipped (${inspection.kind}): ${inspection.reason} Run ${formatCliCommand("openclaw gateway status --deep", env)} before starting it.`;
      warnings.push(warning);
      params.runtime.log(warning);
      return false;
    };
    const revalidate = async (
      state: GatewayServiceState,
      allowIncompleteInspection = false,
    ): Promise<ManagedGatewayUpdateVerdict> => {
      try {
        return await settle(() =>
          revalidateManagedGatewayServiceAfterUpdate({
            state,
            root,
            preManagedServiceStop: before,
            allowIncompleteInspection,
          }),
        );
      } catch (error) {
        if (
          before.stopped ||
          hasCommandProcessCleanupError(error) ||
          findServiceOwnershipRefusal(error)
        ) {
          throw error;
        }
        inspectionFailure = error;
        return { kind: "unavailable", message: formatErrorMessage(error) };
      }
    };
    if (current) {
      assertDoctorServiceSelection(env, current.env);
      const verdict = await revalidate(current, before.stopped);
      if (verdict.kind === "unavailable") {
        inspectionFailure ??= new Error(verdict.message);
      } else {
        installation = verdict;
      }
    }
    if (!(await mayRestore())) {
      return undefined;
    }
    if (
      installation?.kind === "owned" &&
      (installation.requiresInstallRootRefresh || writeConfig)
    ) {
      const originalInstallation = installation;
      if (!inspectionFailure) {
        // Reversing our stop cannot authorize an installation rewrite during another update.
        const assertInstallationCurrent = () => {
          assertMaintenanceCurrent();
          params.assertInstallationAdmission?.();
        };
        assertInstallationCurrent();
        const [{ maybeRepairGatewayServiceConfig }, { createDoctorPrompter }] = await Promise.all([
          import("./doctor-gateway-services.js"),
          import("./doctor-prompter.js"),
        ]);
        assertInstallationCurrent();
        cfg = await settle(() =>
          maybeRepairGatewayServiceConfig(
            cfg,
            "local",
            params.runtime,
            createDoctorPrompter({
              runtime: params.runtime,
              options: params.options,
              signal: params.signal,
            }),
            {
              async writeConfig(nextConfig) {
                assertInstallationCurrent();
                // Failed maintenance entry has no inspected Doctor writer context.
                // Do not fall back to an independent config replacement on recovery.
                if (!writeConfig) {
                  throw new Error(
                    "Doctor config writer is unavailable during service restoration.",
                  );
                }
                const committed = await writeConfig(nextConfig);
                assertInstallationCurrent();
                return committed;
              },
              serviceMaintenance: {
                managerUid: before.serviceManagerUid,
                assertCurrent: assertInstallationCurrent,
                assertReadCurrent: assertInspectionCurrent,
              },
            },
          ),
        );
        assertInstallationCurrent();
        const repairedState = before.stopped ? await readCurrent() : await readInspection();
        assertInstallationCurrent();
        if (!repairedState) {
          await mayRestore();
          return undefined;
        }
        assertDoctorServiceSelection(env, repairedState.env);
        const repaired = await revalidate(repairedState);
        assertInstallationCurrent();
        if (repaired.kind === "owned" && !repaired.requiresInstallRootRefresh) {
          if (
            originalInstallation.requiresInstallRootRefresh ||
            repairedState.runtime?.status === "running"
          ) {
            return repairedState;
          }
          current = repairedState;
        } else if (before.stopped && !originalInstallation.requiresInstallRootRefresh) {
          throw new Error(
            "Gateway service ownership changed during Doctor repair; inspect the service before restarting it.",
          );
        }
        if (!before.stopped) {
          current = repairedState;
          installation = repaired;
          if (!(await mayRestore())) {
            return undefined;
          }
        }
      }
      if (originalInstallation.requiresInstallRootRefresh) {
        const message = `Gateway service still targets ${originalInstallation.root}; Doctor could not reconcile it with ${root}. The previous installation remains stopped because state compatibility is unverified. Run ${formatCliCommand("openclaw gateway install --force", env)} from the intended install.`;
        warnings.push(message);
        params.runtime.log(message);
        return undefined;
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
        ...(before.serviceSystemdIdentity
          ? { systemdIdentity: before.serviceSystemdIdentity }
          : {}),
      });
    });
    assertMaintenanceCurrent();
    return current ?? { env: serviceEnv, command: null };
  });
  return { service, state: restoredState, cfg };
}
