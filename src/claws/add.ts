import type { Stats } from "node:fs";
import { lstat, mkdir, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import { listAgentEntries, toAgentEntriesRecord } from "../agents/agent-scope.js";
import { transformConfigFileWithRetry } from "../config/config.js";
import { applyConfigOverrides } from "../config/runtime-overrides.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { planWithPackageActions, sameCommittedAgent, statusAtLeast } from "./add-plan-helpers.js";
import {
  deleteClawInstallRecordForAdd,
  persistClawInstallRecordForAdd,
  recordAgentProvenanceForAdd,
  updateClawInstallRecordStatusForAdd,
  type ClawAddStateOptions,
} from "./add-state-write.js";
import { ClawBootstrapWriteError, seedClawPackageBootstrap } from "./bootstrap.js";
import {
  ClawCronInstallError,
  installClawCronJobs,
  type ClawCronGateway,
  type PersistedClawCronRef,
} from "./cron.js";
import { replaceLegacyCommittedAgent } from "./legacy-resume.js";
import {
  ClawMcpInstallError,
  installClawMcpServers,
  type PersistedClawMcpServerRef,
} from "./mcp.js";
import {
  ClawPackageInstallError,
  installClawPackages,
  type ClawPluginInstallConsent,
  type ClawSkillInstallConsent,
} from "./packages.js";
import {
  deleteClawInstallRecord,
  persistClawInstallRecord,
  updateClawInstallRecordStatus,
  type ClawInstallStatus,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";
import { CLAW_OUTPUT_STABILITY, type ClawAddPlan } from "./types.js";
import {
  ClawWorkspaceWriteError,
  createClawWorkspaceFiles,
  type PersistedClawWorkspaceFile,
} from "./workspace.js";

export const CLAW_ADD_RESULT_SCHEMA_VERSION = "openclaw.clawAddResult.v1" as const;

type ConfigCommit = (
  transform: (config: OpenClawConfig, runtimeConfig?: OpenClawConfig) => OpenClawConfig,
) => Promise<void>;
type ClawAddApplyOptions = ClawAddStateOptions & {
  config?: OpenClawConfig;
  getCurrentConfig?: () => OpenClawConfig;
  assertReviewedConfig?: (config: OpenClawConfig, phase?: "after-agent-commit") => void;
  assertForwardCurrent?: () => void;
  pluginConsent?: ClawPluginInstallConsent;
  skillConsent?: ClawSkillInstallConsent;
  reloadPlugins?: PluginInstallBatchReload;
  consentPlanIntegrity?: string;
  resumeRecord?: PersistedClawInstall;
  resumePlan?: ClawAddPlan;
  commitConfig?: ConfigCommit;
  persistRecord?: (
    plan: Parameters<typeof persistClawInstallRecord>[0],
    options?: Parameters<typeof persistClawInstallRecord>[1],
  ) => PersistedClawInstall | Promise<PersistedClawInstall>;
  deleteRecord?: (
    agentId: Parameters<typeof deleteClawInstallRecord>[0],
    options?: Parameters<typeof deleteClawInstallRecord>[1],
  ) => void | Promise<void>;
  updateRecord?: (
    agentId: Parameters<typeof updateClawInstallRecordStatus>[0],
    status: Parameters<typeof updateClawInstallRecordStatus>[1],
    options?: Parameters<typeof updateClawInstallRecordStatus>[2],
  ) => void | Promise<void>;
  createWorkspaceFiles?: typeof createClawWorkspaceFiles;
  runtime?: RuntimeEnv;
  installPackages?: typeof installClawPackages;
  installMcpServers?: typeof installClawMcpServers;
  installCronJobs?: typeof installClawCronJobs;
  seedPackageBootstrap?: typeof seedClawPackageBootstrap;
  cronGateway?: Pick<ClawCronGateway, "add" | "list" | "waitUntilAgentAvailable">;
  nowMs?: number;
};
export class ClawAddMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawAddMutationError";
  }
}

type ClawAddResult = {
  schemaVersion: typeof CLAW_ADD_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  mutationAllowed: true;
  planIntegrity: string;
  status: "complete" | "partial";
  claw: ClawAddPlan["claw"];
  agent: ClawAddPlan["agent"];
  workspaceCreated: boolean;
  configCommitted: boolean;
  workspaceFiles: PersistedClawWorkspaceFile[];
  packages: PersistedClawPackageRef[];
  mcpServers: PersistedClawMcpServerRef[];
  cronJobs: PersistedClawCronRef[];
  installRecord?: PersistedClawInstall;
  error?: {
    code: string;
    message: string;
    diagnostics?: ClawWorkspaceWriteError["diagnostics"];
  };
};

async function markInstallStatus(
  agentId: string,
  status: ClawInstallStatus,
  expectedStatuses: ClawInstallStatus[],
  options: ClawAddApplyOptions,
): Promise<void> {
  await (options.updateRecord ?? updateClawInstallRecordStatusForAdd)(agentId, status, {
    ...options,
    expectedStatuses,
  });
}

async function clearUnownedInstallRecord(
  agentId: string,
  expectedStatuses: ClawInstallStatus[],
  options: ClawAddApplyOptions,
): Promise<void> {
  await (options.deleteRecord ?? deleteClawInstallRecordForAdd)(agentId, {
    ...options,
    expectedStatuses,
  });
}

function workspacePathKey(value: string): string {
  return process.platform === "win32" ? normalizeWindowsPathForComparison(value) : value;
}

function assertWorkspacePathUnchanged(workspace: string): void {
  const canonicalWorkspace = resolvePathViaExistingAncestorSync(workspace);
  if (workspacePathKey(canonicalWorkspace) !== workspacePathKey(workspace)) {
    throw new ClawAddMutationError(
      "workspace_path_changed",
      `Workspace ancestry changed after planning: expected ${JSON.stringify(workspace)}, resolved ${JSON.stringify(canonicalWorkspace)}.`,
    );
  }
}

export async function applyClawAddPlan(
  plan: ClawAddPlan,
  options: ClawAddApplyOptions = {},
): Promise<ClawAddResult> {
  if (plan.blockers.length > 0) {
    throw new ClawAddMutationError("plan_blocked", "The Claw add plan contains blockers.");
  }
  if (options.consentPlanIntegrity !== (options.resumePlan?.planIntegrity ?? plan.planIntegrity)) {
    throw new ClawAddMutationError(
      "plan_integrity_mismatch",
      "Consent does not match the current Claw add plan; run add --dry-run again.",
    );
  }

  const assertReviewedCurrent = (phase?: "after-agent-commit") => {
    if (!options.getCurrentConfig || !options.assertReviewedConfig) {
      return;
    }
    options.assertCurrent?.();
    options.assertReviewedConfig(options.getCurrentConfig(), phase);
    options.assertCurrent?.();
  };
  const assertForwardCurrent = (phase?: "after-agent-commit") => {
    options.assertCurrent?.();
    options.assertForwardCurrent?.();
    assertReviewedCurrent(phase);
  };
  const stageOptions = (phase?: "after-agent-commit"): ClawAddApplyOptions => ({
    ...options,
    assertForwardCurrent: () => assertForwardCurrent(phase),
  });
  const forwardStateOptions = (phase?: "after-agent-commit"): ClawAddApplyOptions => ({
    ...stageOptions(phase),
    assertCurrent: () => assertForwardCurrent(phase),
  });
  const initialPhase =
    options.resumeRecord && statusAtLeast(options.resumeRecord.status, "config_committed")
      ? "after-agent-commit"
      : undefined;

  const persistRecord = options.persistRecord ?? persistClawInstallRecordForAdd;
  let installRecord: PersistedClawInstall;
  try {
    assertForwardCurrent(initialPhase);
    installRecord = await persistRecord(plan, {
      ...forwardStateOptions(initialPhase),
      status: "pending",
      expectedExistingRecord: options.resumeRecord,
      expectedExistingPlan: options.resumePlan,
      deferLegacyPlanUpgrade: options.resumePlan !== undefined,
    });
  } catch (error) {
    if (error instanceof ClawAddMutationError) {
      throw error;
    }
    throw new ClawAddMutationError("provenance_failed", (error as Error).message);
  }

  const markRecordedStatus = async (
    status: ClawInstallStatus,
    expectedStatuses: ClawInstallStatus[],
    phase?: "before-agent-commit" | "after-agent-commit",
  ): Promise<void> => {
    await markInstallStatus(
      plan.agent.finalId,
      status,
      expectedStatuses,
      phase ? forwardStateOptions(phase === "after-agent-commit" ? phase : undefined) : options,
    );
    installRecord = {
      ...installRecord,
      status,
      updatedAtMs: options.nowMs ?? Date.now(),
    };
  };

  let workspaceCreated = false;
  let configCommitted = false;
  let workspaceFiles: PersistedClawWorkspaceFile[] = [];
  let packages: PersistedClawPackageRef[] = [];
  let mcpServers: PersistedClawMcpServerRef[] = [];
  let cronJobs: PersistedClawCronRef[] = [];
  const partialResult = ({
    ...overrides
  }: Partial<
    Pick<
      ClawAddResult,
      | "workspaceCreated"
      | "configCommitted"
      | "workspaceFiles"
      | "packages"
      | "mcpServers"
      | "cronJobs"
    >
  > & {
    error: ClawAddResult["error"];
  }): ClawAddResult => ({
    schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    mutationAllowed: true,
    planIntegrity: plan.planIntegrity,
    status: "partial",
    claw: plan.claw,
    agent: plan.agent,
    workspaceCreated,
    configCommitted,
    workspaceFiles,
    packages,
    mcpServers,
    cronJobs,
    installRecord,
    ...overrides,
  });

  const workspace = resolve(resolveUserPath(plan.agent.workspace));
  const removeEmptyWorkspaceIfAuthorized = async (): Promise<boolean> => {
    try {
      options.assertCurrent?.();
      await rmdir(workspace);
      return true;
    } catch {
      return false;
    }
  };
  const workspacePhaseRecorded = statusAtLeast(installRecord.status, "workspace_ready");
  let workspaceState: Stats | undefined;
  try {
    assertWorkspacePathUnchanged(workspace);
    workspaceState = await lstat(workspace).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    });
  } catch (error) {
    await clearUnownedInstallRecord(plan.agent.finalId, ["pending", "partial"], options);
    if (error instanceof ClawAddMutationError) {
      throw error;
    }
    throw new ClawAddMutationError(
      "workspace_parent_failed",
      `Could not inspect workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
    );
  }

  if (!workspacePhaseRecorded && workspaceState) {
    await markRecordedStatus("partial", ["pending", "partial"]);
    return partialResult({
      workspaceCreated: false,
      configCommitted: false,
      packages: [],
      error: {
        code: "workspace_collision",
        message: `Workspace ${JSON.stringify(workspace)} was created after planning.`,
      },
    });
  }
  if (workspaceState && !workspaceState.isDirectory()) {
    throw new ClawAddMutationError(
      "workspace_collision",
      `Workspace ${JSON.stringify(workspace)} is no longer a directory.`,
    );
  }

  workspaceCreated = workspaceState?.isDirectory() ?? false;
  configCommitted = statusAtLeast(installRecord.status, "config_committed");
  const installPackages = options.installPackages ?? installClawPackages;
  const preserveRecordedPhaseOrMarkPartial = async (): Promise<void> => {
    if (workspacePhaseRecorded) {
      return;
    }
    await markRecordedStatus("partial", ["pending", "partial"]);
  };

  const hostRequirementPlan = planWithPackageActions(
    plan,
    (action) => action.details?.kind === "plugin",
  );
  const hostRequirementActions = hostRequirementPlan.actions.filter(
    (action) => action.kind === "package",
  );
  if (hostRequirementActions.length > 0) {
    try {
      assertForwardCurrent(initialPhase);
      packages = await installPackages(hostRequirementPlan, stageOptions(initialPhase));
    } catch (error) {
      const packageError = error instanceof ClawPackageInstallError ? error : undefined;
      await preserveRecordedPhaseOrMarkPartial();
      return partialResult({
        packages: packageError?.installedPackages ?? packages,
        error: {
          code: packageError?.code ?? "package_install_failed",
          message: packageError?.message ?? coerceErrorMessage(error),
        },
      });
    }
  }

  try {
    assertWorkspacePathUnchanged(workspace);
    assertForwardCurrent(initialPhase);
    await mkdir(dirname(workspace), { recursive: true });
    assertWorkspacePathUnchanged(workspace);
    assertForwardCurrent(initialPhase);
  } catch (error) {
    if (packages.length > 0) {
      await preserveRecordedPhaseOrMarkPartial();
      return partialResult({
        error: {
          code: error instanceof ClawAddMutationError ? error.code : "workspace_parent_failed",
          message:
            error instanceof ClawAddMutationError
              ? error.message
              : `Could not create parent directory for workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
        },
      });
    }
    await clearUnownedInstallRecord(plan.agent.finalId, ["pending", "partial"], options);
    if (error instanceof ClawAddMutationError) {
      throw error;
    }
    throw new ClawAddMutationError(
      "workspace_parent_failed",
      `Could not create parent directory for workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
    );
  }

  if (!workspaceCreated) {
    try {
      assertForwardCurrent(initialPhase);
      await mkdir(workspace);
      workspaceCreated = true;
    } catch (error) {
      await markRecordedStatus("partial", ["pending", "partial"]);
      return partialResult({
        workspaceCreated: false,
        configCommitted: false,
        error: {
          code: "workspace_collision",
          message: `Could not create new workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
        },
      });
    }

    try {
      if (!workspacePhaseRecorded) {
        await markRecordedStatus(
          "workspace_ready",
          ["pending", "partial", "workspace_ready"],
          "before-agent-commit",
        );
      }
    } catch (error) {
      const removedWorkspace = await removeEmptyWorkspaceIfAuthorized();
      if (removedWorkspace) {
        try {
          await clearUnownedInstallRecord(plan.agent.finalId, ["pending", "partial"], options);
        } catch {
          // Preserve the phase-write failure if the unowned attempt cannot be reconciled.
        }
      }
      throw new ClawAddMutationError("provenance_failed", (error as Error).message);
    }
  }

  // Seed and attest the consented package bootstrap while the workspace is still
  // private. Committing the agent config first makes the agent routable, so a
  // concurrent `sessions.create` can stock-seed BOOTSTRAP.md and strand the add at
  // `config_committed` with a seed conflict that no retry can clear.
  try {
    assertForwardCurrent(initialPhase);
    await (options.seedPackageBootstrap ?? seedClawPackageBootstrap)(plan, {
      ...stageOptions(initialPhase),
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    });
  } catch (error) {
    const installStatus: ClawInstallStatus = configCommitted
      ? "config_committed"
      : "workspace_ready";
    await markRecordedStatus(
      installStatus,
      configCommitted ? ["config_committed"] : ["workspace_ready", "config_committed"],
    );
    return partialResult({
      error: {
        code: error instanceof ClawBootstrapWriteError ? error.code : "bootstrap_write_failed",
        message: coerceErrorMessage(error),
      },
    });
  }

  try {
    const commit: ConfigCommit =
      options.commitConfig ??
      (async (transform) => {
        await transformConfigFileWithRetry({
          afterWrite: { mode: "auto" },
          writeOptions: {
            assertCurrent: options.assertCurrent,
            beforeCommit: () => assertForwardCurrent(initialPhase),
          },
          transform: (config, context) => ({
            nextConfig: transform(config, context.snapshot.runtimeConfig),
          }),
        });
      });
    assertForwardCurrent(initialPhase);
    await commit((config, runtimeConfig) => {
      options.assertCurrent?.();
      options.assertForwardCurrent?.();
      options.assertReviewedConfig?.(applyConfigOverrides(runtimeConfig ?? config), initialPhase);
      const existingAgents = listAgentEntries(config);
      const agentsToPreserve: AgentConfig[] =
        existingAgents.length > 0 ? existingAgents : [{ id: DEFAULT_AGENT_ID, default: true }];
      const configWithPreservedAgents: OpenClawConfig = {
        ...config,
        agents: {
          ...config.agents,
          entries: toAgentEntriesRecord(agentsToPreserve),
        },
      };
      const normalizedAgentId = normalizeAgentId(plan.agent.finalId);
      const existingAgent = agentsToPreserve.find(
        (agent) => normalizeAgentId(agent.id) === normalizedAgentId,
      );
      if (existingAgent) {
        if (sameCommittedAgent(existingAgent, plan)) {
          return config;
        }
        const nextConfig = replaceLegacyCommittedAgent({
          config: configWithPreservedAgents,
          agents: agentsToPreserve,
          normalizedAgentId,
          plan,
          resumePlan: options.resumePlan,
          resumeRecord: options.resumeRecord,
          matchesPlan: sameCommittedAgent,
        });
        if (nextConfig) {
          return nextConfig;
        }
        throw new ClawAddMutationError(
          "agent_id_collision",
          "Agent " + JSON.stringify(plan.agent.finalId) + " was created after planning.",
        );
      }
      if (
        findOverlappingWorkspaceAgentIds(configWithPreservedAgents, plan.agent.finalId, workspace)
          .length > 0
      ) {
        throw new ClawAddMutationError(
          "workspace_collision",
          "Workspace " + JSON.stringify(workspace) + " is already assigned to an agent.",
        );
      }
      const nextConfig: OpenClawConfig = {
        ...config,
        agents: {
          ...config.agents,
          entries: toAgentEntriesRecord([...agentsToPreserve, plan.agent.config]),
        },
      };
      return nextConfig;
    });
    // The transform runs before persistence can still fail; record the fact only after commit.
    // Moving this into the callback retains the workspace and reports a write that never landed.
    configCommitted = true;
    try {
      assertForwardCurrent("after-agent-commit");
      await recordAgentProvenanceForAdd(
        plan.agent.finalId,
        { createdVia: "claw" },
        forwardStateOptions("after-agent-commit"),
      );
    } catch (error) {
      if (error instanceof ClawAddMutationError) {
        throw error;
      }
      throw new ClawAddMutationError("provenance_failed", coerceErrorMessage(error));
    }
    if (options.resumePlan && installRecord.schemaVersion === "openclaw.clawInstallRecord.v1") {
      installRecord = await persistRecord(plan, {
        ...forwardStateOptions("after-agent-commit"),
        status: "pending",
        expectedExistingRecord: options.resumeRecord,
        expectedExistingPlan: options.resumePlan,
      });
    }
    await markRecordedStatus(
      "config_committed",
      ["workspace_ready", "config_committed"],
      "after-agent-commit",
    );
  } catch (error) {
    if (configCommitted && !options.resumePlan) {
      try {
        await markRecordedStatus("config_committed", ["workspace_ready", "config_committed"]);
      } catch {
        // Keep the original failure; status repair remains available on retry.
      }
    } else if (!configCommitted) {
      const removedWorkspace = await removeEmptyWorkspaceIfAuthorized();
      if (removedWorkspace) {
        workspaceCreated = false;
        await markRecordedStatus("partial", ["workspace_ready", "partial"]);
      }
    }
    return partialResult({
      error: {
        code: error instanceof ClawAddMutationError ? error.code : "config_commit_failed",
        message: coerceErrorMessage(error),
      },
    });
  }

  const createFiles = options.createWorkspaceFiles ?? createClawWorkspaceFiles;
  try {
    assertForwardCurrent("after-agent-commit");
    workspaceFiles = await createFiles(plan, stageOptions("after-agent-commit"));
  } catch (error) {
    const workspaceError =
      error instanceof ClawWorkspaceWriteError
        ? error
        : new ClawWorkspaceWriteError(
            [
              {
                level: "error",
                code: "workspace_file_io_error",
                phase: "mutation",
                path: "$.workspace",
                message: coerceErrorMessage(error),
              },
            ],
            workspaceFiles,
          );
    await markRecordedStatus("config_committed", ["config_committed"]);
    return partialResult({
      workspaceFiles: workspaceError.createdFiles,
      error: {
        code: error instanceof ClawAddMutationError ? error.code : "workspace_files_failed",
        message: workspaceError.message,
        diagnostics: workspaceError.diagnostics,
      },
    });
  }

  try {
    // Skills require their workspace. Recurring work is enabled only after all
    // package mutation succeeds.
    const workspacePackagePlan = planWithPackageActions(
      plan,
      (action) => action.details?.kind !== "plugin",
    );
    const workspacePackageActions = workspacePackagePlan.actions.filter(
      (action) => action.kind === "package",
    );
    if (workspacePackageActions.length > 0) {
      assertForwardCurrent("after-agent-commit");
      const workspacePackages = await installPackages(
        workspacePackagePlan,
        stageOptions("after-agent-commit"),
      );
      packages = [...packages, ...workspacePackages];
    }
  } catch (error) {
    const packageError = error instanceof ClawPackageInstallError ? error : undefined;
    return partialResult({
      packages: [...packages, ...(packageError?.installedPackages ?? [])],
      error: {
        code: packageError?.code ?? "package_install_failed",
        message: packageError?.message ?? coerceErrorMessage(error),
      },
    });
  }

  const installMcpServers = options.installMcpServers ?? installClawMcpServers;
  try {
    assertForwardCurrent("after-agent-commit");
    mcpServers = await installMcpServers(plan, stageOptions("after-agent-commit"));
  } catch (error) {
    const mcpError = error instanceof ClawMcpInstallError ? error : undefined;
    await markRecordedStatus("config_committed", ["config_committed"]);
    return partialResult({
      mcpServers: mcpError?.mcpServers ?? mcpServers,
      error: {
        code: mcpError?.code ?? "mcp_install_failed",
        message: mcpError?.message ?? coerceErrorMessage(error),
      },
    });
  }

  const installCronJobs = options.installCronJobs ?? installClawCronJobs;
  try {
    assertForwardCurrent("after-agent-commit");
    cronJobs = await installCronJobs(plan, {
      ...stageOptions("after-agent-commit"),
      gateway: options.cronGateway,
    });
  } catch (error) {
    const cronError = error instanceof ClawCronInstallError ? error : undefined;
    await markRecordedStatus("config_committed", ["config_committed"]);
    return partialResult({
      cronJobs: cronError?.cronJobs ?? cronJobs,
      error: {
        code: cronError?.code ?? "cron_install_failed",
        message: cronError?.message ?? coerceErrorMessage(error),
      },
    });
  }

  try {
    await markRecordedStatus("complete", ["config_committed", "complete"], "after-agent-commit");
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
      installRecord,
    };
  } catch (error) {
    return partialResult({
      error: { code: "provenance_failed", message: (error as Error).message },
    });
  }
}
