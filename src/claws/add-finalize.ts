import { coerceErrorMessage } from "@openclaw/normalization-core";
import { assertApplyLeaseOwned, markInstallStatus } from "./add-apply-support.js";
import {
  CLAW_ADD_RESULT_SCHEMA_VERSION,
  partialResult,
  type ClawAddApplyOptions,
  type ClawAddResult,
} from "./add-contract.js";
import { planWithPackageActions } from "./add-plan-helpers.js";
import { ClawCronInstallError, installClawCronJobs, type PersistedClawCronRef } from "./cron.js";
import {
  ClawMcpInstallError,
  installClawMcpServers,
  type PersistedClawMcpServerRef,
} from "./mcp.js";
import { ClawPackageInstallError } from "./packages.js";
import type { PersistedClawInstall, PersistedClawPackageRef } from "./provenance.js";
import { CLAW_OUTPUT_STABILITY, type ClawAddPlan } from "./types.js";
import type { PersistedClawWorkspaceFile } from "./workspace.js";

/** Finish the routable agent's packages, Gateway resources, and durable complete phase. */
export async function finalizeClawAddPlan(params: {
  plan: ClawAddPlan;
  options: ClawAddApplyOptions;
  installRecord: PersistedClawInstall;
  workspaceCreated: boolean;
  configCommitted: boolean;
  workspaceFiles: PersistedClawWorkspaceFile[];
  packages: PersistedClawPackageRef[];
  installPackages: NonNullable<ClawAddApplyOptions["installPackages"]>;
}): Promise<ClawAddResult> {
  const { plan, options, installRecord, workspaceCreated, configCommitted, workspaceFiles } =
    params;
  let packages = params.packages;
  try {
    // Skills require their workspace. Recurring work is enabled only after all package mutation
    // succeeds.
    const workspacePackagePlan = planWithPackageActions(
      plan,
      (action) => action.details?.kind !== "plugin",
    );
    const workspacePackageActions = workspacePackagePlan.actions.filter(
      (action) => action.kind === "package",
    );
    if (workspacePackageActions.length > 0) {
      assertApplyLeaseOwned(options);
      const workspacePackages = await params.installPackages(workspacePackagePlan, options);
      assertApplyLeaseOwned(options);
      packages = [...packages, ...workspacePackages];
    }
  } catch (error) {
    const packageError =
      error instanceof ClawPackageInstallError
        ? error
        : new ClawPackageInstallError("package_install_failed", coerceErrorMessage(error), []);
    return partialResult({
      plan,
      installRecord,
      workspaceCreated,
      configCommitted,
      workspaceFiles,
      packages: [...packages, ...packageError.installedPackages],
      installStatus: "config_committed",
      error: { code: packageError.code, message: packageError.message },
      nowMs: options.nowMs,
    });
  }

  const installMcpServers = options.installMcpServers ?? installClawMcpServers;
  let mcpServers: PersistedClawMcpServerRef[] = [];
  try {
    assertApplyLeaseOwned(options);
    mcpServers = await installMcpServers(plan, options);
    assertApplyLeaseOwned(options);
  } catch (error) {
    assertApplyLeaseOwned(options);
    const mcpError =
      error instanceof ClawMcpInstallError
        ? error
        : new ClawMcpInstallError("mcp_install_failed", coerceErrorMessage(error), mcpServers);
    markInstallStatus(plan.agent.finalId, "config_committed", ["config_committed"], options);
    return partialResult({
      plan,
      installRecord,
      workspaceCreated,
      configCommitted,
      workspaceFiles,
      packages,
      mcpServers: mcpError.mcpServers,
      installStatus: "config_committed",
      error: { code: mcpError.code, message: mcpError.message },
      nowMs: options.nowMs,
    });
  }

  const installCronJobs = options.installCronJobs ?? installClawCronJobs;
  let cronJobs: PersistedClawCronRef[] = [];
  try {
    assertApplyLeaseOwned(options);
    cronJobs = await installCronJobs(plan, { ...options, gateway: options.cronGateway });
    assertApplyLeaseOwned(options);
  } catch (error) {
    assertApplyLeaseOwned(options);
    const cronError =
      error instanceof ClawCronInstallError
        ? error
        : new ClawCronInstallError("cron_install_failed", coerceErrorMessage(error), cronJobs);
    markInstallStatus(plan.agent.finalId, "config_committed", ["config_committed"], options);
    return partialResult({
      plan,
      installRecord,
      workspaceCreated,
      configCommitted,
      workspaceFiles,
      packages,
      mcpServers,
      cronJobs: cronError.cronJobs,
      installStatus: "config_committed",
      error: { code: cronError.code, message: cronError.message },
      nowMs: options.nowMs,
    });
  }

  try {
    markInstallStatus(plan.agent.finalId, "complete", ["config_committed", "complete"], options);
    return {
      schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      mutationAllowed: true,
      planIntegrity: plan.planIntegrity,
      status: "complete",
      claw: plan.claw,
      agent: plan.agent,
      workspaceCreated,
      configCommitted,
      packages,
      mcpServers,
      cronJobs,
      workspaceFiles,
      installRecord: {
        ...installRecord,
        status: "complete",
        updatedAtMs: options.nowMs ?? Date.now(),
      },
    };
  } catch (error) {
    return partialResult({
      plan,
      installRecord,
      workspaceCreated,
      configCommitted,
      workspaceFiles,
      packages,
      mcpServers,
      cronJobs,
      error: { code: "provenance_failed", message: coerceErrorMessage(error) },
    });
  }
}
