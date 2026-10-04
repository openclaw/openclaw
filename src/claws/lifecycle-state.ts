import { coerceErrorMessage } from "@openclaw/normalization-core";
import { getRuntimeConfig } from "../config/config.js";
import { clawCronGatewayJobMatchesRef, deleteClawCronRef, markClawCronRefRemoved } from "./cron.js";
import { CLAW_PORTABLE_HEARTBEAT_ID } from "./cron.types.js";
import { applyClawAdoptedRemovePlan } from "./lifecycle-adopted-removal.js";
import {
  clawBootstrapStateBlocksRemove,
  removeClawBootstrap,
} from "./lifecycle-bootstrap-removal.js";
import { withClawAgentConfigRemoval } from "./lifecycle-config-removal.js";
import {
  clawRemoveQuietRuntime,
  ClawRemoveError,
  cleanupClawAgentFilesystem,
  releaseClawRemoveRows,
  removeClawWorkspaceFile,
  workspaceContainsUntrackedEntries,
} from "./lifecycle-delete-support.js";
import { removeClawMcpServers } from "./lifecycle-mcp-removal.js";
import {
  CLAW_REMOVE_RESULT_SCHEMA_VERSION,
  type ClawRemoveApplyOptions,
  type ClawRemoveResult,
  type ClawRemovePlan,
} from "./lifecycle-remove-contract.js";
import { buildClawRemovePlan } from "./lifecycle-remove-plan.js";
import { readClawStatus } from "./lifecycle-status.js";
import { planClawMcpServerRemoval } from "./mcp.js";
import { clawMonitorSnapshotSchema } from "./monitor-cleanup-contract.js";
import { applyClawPackageRemovalPhase } from "./package-remove-phase.js";
import { filterReferencedCleanup } from "./package-remove-plan.js";
import { planClawPackageRemovals } from "./package-remove.js";
import { readPortableHeartbeatState } from "./portable-heartbeat-state.js";
import { portableHeartbeatStateDigest } from "./portable-heartbeat-state.kernel.js";
import { removePortableHeartbeat, publishPortableHeartbeat } from "./portable-heartbeat.js";
import { CLAW_OUTPUT_STABILITY } from "./types.js";

export { ClawRemoveError } from "./lifecycle-delete-support.js";
export {
  CLAW_REMOVE_PLAN_SCHEMA_VERSION,
  CLAW_REMOVE_RESULT_SCHEMA_VERSION,
} from "./lifecycle-remove-contract.js";
export { buildClawRemovePlan } from "./lifecycle-remove-plan.js";
export { readClawStatus, type ClawStatusRecord } from "./lifecycle-status.js";

export async function applyClawRemovePlan(
  plan: ClawRemovePlan,
  options: ClawRemoveApplyOptions = {},
): Promise<ClawRemoveResult> {
  if (options.consentPlanIntegrity !== plan.planIntegrity) {
    throw new ClawRemoveError(
      "plan_integrity_mismatch",
      "Consent does not match the current Claw remove plan; run remove --dry-run again.",
    );
  }
  if (plan.blockers.length > 0 || !plan.agentId) {
    throw new ClawRemoveError("remove_blocked", "The Claw remove plan contains blockers.");
  }
  if (
    plan.actions.some((action) => action.kind === "installRecord" && action.action === "release")
  ) {
    return await applyClawAdoptedRemovePlan(plan, options);
  }
  const monitorGateway = options.monitorGateway;
  if (!monitorGateway) {
    throw new ClawRemoveError(
      "monitor_gateway_required",
      "Claw removal requires the serving Gateway to establish safe cancellation and drainage.",
    );
  }
  const currentPlan = await buildClawRemovePlan(plan.target, options);
  if (currentPlan.planIntegrity !== plan.planIntegrity) {
    throw new ClawRemoveError("remove_changed", "Claw-owned state changed after remove planning.");
  }
  const agentId = plan.agentId;
  const current = await readClawStatus(plan.agentId, options);
  const record = current.records[0];
  const plannedAgentAction = plan.actions.find(
    (action) => action.kind === "agent" && action.id === agentId,
  );
  const expectedRemovalSurfaceDigest = plannedAgentAction?.details?.removalSurfaceDigest;
  if (typeof expectedRemovalSurfaceDigest !== "string") {
    throw new ClawRemoveError("remove_changed", "Claw remove plan is missing config state.");
  }
  if (
    !record ||
    record.agentState === "modified" ||
    clawBootstrapStateBlocksRemove(record) ||
    record.workspaceFiles.some((file) => file.state === "unsafe") ||
    record.mcpServers.some((server) => server.state === "pending")
  ) {
    throw new ClawRemoveError("remove_changed", "Claw-owned state changed after remove planning.");
  }
  const packageDecisions = await planClawPackageRemovals(record.install, record.packages, {
    ...options,
    deps: options.packageDeps,
    referencedCleanup: filterReferencedCleanup(options.referencedCleanup, "package"),
  });
  const plannedPackages = plan.actions
    .filter((action) => action.kind === "packageRef")
    .map((action) => `${action.id}:${action.action}`)
    .toSorted();
  const currentPackages = packageDecisions
    .map(
      (decision) =>
        `${decision.packageRef.kind}:${decision.packageRef.ref}@${decision.packageRef.version}:${decision.action === "uninstall" ? "uninstall" : "release"}`,
    )
    .toSorted();
  if (JSON.stringify(plannedPackages) !== JSON.stringify(currentPackages)) {
    throw new ClawRemoveError("remove_changed", "Package ownership changed after remove planning.");
  }
  const plannedMcpServers = plan.actions
    .filter((action) => action.kind === "mcpServer")
    .map((action) => `${action.id}:${action.action}`)
    .toSorted();
  const currentMcpServers = record.mcpServers
    .map((server) => `${server.name}:${planClawMcpServerRemoval(server, options).action}`)
    .toSorted();
  if (JSON.stringify(plannedMcpServers) !== JSON.stringify(currentMcpServers)) {
    throw new ClawRemoveError("remove_changed", "MCP ownership changed after remove planning.");
  }
  const result: ClawRemoveResult = {
    schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    status: "partial",
    agentId,
    agentRemoved: false,
    workspaceFiles: [],
    packages: [],
    mcpServers: [],
    cronJobs: [],
    packageRefsReleased: 0,
  };
  const partial = (code: string, message: string): ClawRemoveResult => ({
    ...result,
    error: { code, message },
  });
  const monitors = currentPlan.actions
    .filter((action) => action.kind === "scheduledJob" && action.action === "remove")
    .map((action) => clawMonitorSnapshotSchema.parse(action.details));
  return await withClawAgentConfigRemoval<ClawRemoveResult>(
    {
      agentId,
      expectedDigest: record.install.agentConfigDigest,
      expectedInstall: record.orphaned ? null : record.install,
      expectedRemovalSurfaceDigest,
      expectedState: record.agentState,
      fallbackWorkspace: record.install.workspace,
      config: options.config,
      stateDatabase: options,
      onModified: () =>
        new ClawRemoveError("agent_modified", "Agent config changed during remove."),
      quiesceMonitors: (operationId) => monitorGateway.quiesce(agentId, operationId, monitors),
      drainMonitors: async (operationId) => await monitorGateway.drain(agentId, operationId),
    },
    async (commitRemoval, assertCurrent, captureWorkerWriteAuthority) => {
      assertCurrent();
      const mcpRemoval = await removeClawMcpServers({
        agentId,
        servers: record.mcpServers,
        options,
        assertCurrent,
      });
      assertCurrent();
      result.mcpServers = mcpRemoval.mcpServers;
      if (mcpRemoval.error) {
        return partial("mcp_cleanup_failed", mcpRemoval.error);
      }
      const cronJobs = result.cronJobs;
      for (const cron of record.cronJobs) {
        if (cron.status !== "removed" && (!cron.schedulerJobId || cron.status !== "complete")) {
          throw new ClawRemoveError(
            "cron_cleanup_uncertain",
            `Cron declaration ${JSON.stringify(cron.manifestId)} is not safely removable.`,
          );
        }
        if (
          cron.status !== "removed" &&
          (!options.cronGateway?.get || !options.cronGateway.remove)
        ) {
          throw new ClawRemoveError(
            "cron_gateway_required",
            "Claw cron jobs require the gateway-owned cron.get and cron.remove APIs.",
          );
        }
        try {
          if (cron.status !== "removed") {
            const live = await options.cronGateway!.get!(cron.schedulerJobId!);
            if (live != null && !clawCronGatewayJobMatchesRef(agentId, cron, live)) {
              throw new Error(
                `Cron declaration ${JSON.stringify(cron.manifestId)} changed after planning.`,
              );
            }
            assertCurrent();
            if (live != null) {
              try {
                await options.cronGateway!.remove(cron.schedulerJobId!);
              } catch (removeError) {
                // Re-read after transport loss; a durable removal may have succeeded.
                const afterRemove = await options.cronGateway!.get!(cron.schedulerJobId!);
                if (afterRemove != null) {
                  throw removeError;
                }
              }
            }
            assertCurrent();
            markClawCronRefRemoved(agentId, cron.manifestId, options);
          }
          deleteClawCronRef(agentId, cron.manifestId, options);
          cronJobs.push({
            manifestId: cron.manifestId,
            schedulerJobId: cron.schedulerJobId,
            action: "removed",
          });
        } catch (error) {
          const message = coerceErrorMessage(error);
          cronJobs.push({
            manifestId: cron.manifestId,
            schedulerJobId: cron.schedulerJobId,
            action: "error",
            message,
          });
          return partial("cron_cleanup_failed", message);
        }
      }
      const portableAction = plan.actions.find(
        (action) => action.kind === "cronJob" && action.id === CLAW_PORTABLE_HEARTBEAT_ID,
      );
      if (portableAction) {
        const config = options.config ?? getRuntimeConfig();
        const portable = await readPortableHeartbeatState(agentId, config, options);
        if (portableHeartbeatStateDigest(portable) !== portableAction.details?.stateDigest) {
          throw new ClawRemoveError(
            "remove_changed",
            "Portable automation changed during removal.",
          );
        }
        assertCurrent();
        await removePortableHeartbeat(agentId, config, portable, {
          ...options,
          assertCurrent,
          workerAuthority: captureWorkerWriteAuthority(),
          expectedInstall: record.orphaned ? null : record.install,
        });
        await publishPortableHeartbeat(agentId, config, options);
        assertCurrent();
        cronJobs.push({
          manifestId: CLAW_PORTABLE_HEARTBEAT_ID,
          schedulerJobId: portable.receipt?.jobId,
          action: "removed",
        });
      }
      const configRemoval = await commitRemoval();
      const { cleanupTargets, configBeforeDelete, completeDeletion } = configRemoval;
      result.agentRemoved = configRemoval.agentRemoved;
      try {
        await configRemoval.drainMonitors();
        configRemoval.assertCurrent();
      } catch (error) {
        return partial("monitor_cleanup_failed", coerceErrorMessage(error));
      }
      const purgeSessions =
        options.purgeSessions ??
        (await import("../config/sessions/cleanup-service.js")).purgeAgentSessionStoreEntries;
      const purgeFailed = await purgeSessions(configBeforeDelete, agentId, {
        env: options.env,
        runDatabaseCleanup: configRemoval.runDatabaseCleanup,
      });
      assertCurrent();
      if (purgeFailed) {
        return partial(
          "session_cleanup_failed",
          "Session cleanup failed; correct the reported error and retry Claw removal.",
        );
      }
      try {
        const removed = await applyClawPackageRemovalPhase(packageDecisions, {
          ...options,
          agentId,
          operationId: configRemoval.operationId,
          assertCurrent,
        });
        result.packages = removed.packages;
        result.pluginRuntime = removed.application;
        result.warnings = removed.warnings;
      } catch (error) {
        return partial("package_cleanup_failed", coerceErrorMessage(error));
      }
      assertCurrent();
      const packageErrors = result.packages.filter((pkg) => pkg.action === "error");
      if (packageErrors.length > 0) {
        return partial("package_cleanup_failed", packageErrors.map((pkg) => pkg.reason).join("; "));
      }
      const workspaceFiles = result.workspaceFiles;
      for (const file of record.workspaceFiles) {
        assertCurrent();
        workspaceFiles.push(await removeClawWorkspaceFile(file, assertCurrent));
      }
      assertCurrent();
      const bootstrap = await removeClawBootstrap(record, assertCurrent);
      const cleanupErrors = workspaceFiles
        .filter((file) => file.action === "error")
        .map((file) => file.message ?? `Could not remove ${file.path}.`);
      if (bootstrap?.action === "error") {
        cleanupErrors.push(bootstrap.message ?? `Could not remove ${bootstrap.path}.`);
      }
      if (cleanupErrors.length === 0) {
        const workspaceHasRemainingEntries = await workspaceContainsUntrackedEntries(
          cleanupTargets.workspaceDir,
          record.workspaceFiles.map((file) => file.path),
        );
        configRemoval.assertCurrent();
        cleanupErrors.push(
          ...(await cleanupClawAgentFilesystem({
            agentId,
            nextConfig: configRemoval.nextConfig,
            targets: cleanupTargets,
            runtime: clawRemoveQuietRuntime,
            trashPath: options.trashPath,
            stateDatabase: options,
            assertCurrent,
            retainWorkspace:
              workspaceHasRemainingEntries ||
              bootstrap?.action === "retainedModified" ||
              workspaceFiles.some((file) => file.action === "retainedModified"),
          })),
        );
      }
      const complete = releaseClawRemoveRows(
        agentId,
        workspaceFiles,
        cleanupErrors,
        configRemoval.assertCurrent,
        completeDeletion,
        options,
      );
      return {
        ...result,
        status: complete ? "complete" : "partial",
        ...(bootstrap ? { bootstrap } : {}),
        packageRefsReleased: complete ? record.packages.length : 0,
        ...(complete
          ? {}
          : {
              error: {
                code: "workspace_cleanup_failed",
                message: cleanupErrors.join("; "),
              },
            }),
      };
    },
  ).catch((error: unknown) =>
    partial(
      error instanceof ClawRemoveError ? error.code : "monitor_cleanup_failed",
      coerceErrorMessage(error),
    ),
  );
}
