import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import { transformConfigFileWithRetry } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  applyClawCronUpdate,
  ClawCronUpdateError,
  type ClawCronUpdateExecution,
} from "./cron-update.js";
import type { ClawCronGateway } from "./cron.js";
import { buildClawAddPlan } from "./lifecycle.js";
import {
  applyClawMcpUpdate,
  ClawMcpUpdateError,
  type ClawMcpUpdateExecution,
} from "./mcp-update.js";
import {
  applyClawPackageUpdate,
  ClawPackageUpdateError,
  type ClawPackageUpdateExecution,
} from "./package-update.js";
import {
  readClawInstallRecord,
  updateClawInstallRecord,
  type PersistedClawInstall,
} from "./provenance.js";
import { CLAW_OUTPUT_STABILITY, type ClawManifest, type ClawSourceIdentity } from "./types.js";
import { buildClawUpdatePlan, type ClawUpdateAction, type ClawUpdatePlan } from "./update-plan.js";
import {
  applyClawWorkspaceUpdate,
  ClawWorkspaceUpdateError,
  type ClawWorkspaceUpdateExecution,
} from "./workspace-update.js";

export const CLAW_UPDATE_RESULT_SCHEMA_VERSION = "openclaw.clawUpdateResult.v1" as const;

type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;

export class ClawUpdateMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawUpdateMutationError";
  }
}

export type ClawUpdateResult = {
  schemaVersion: typeof CLAW_UPDATE_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  mutationAllowed: true;
  status: "complete";
  agentId: string;
  previousClaw: NonNullable<ClawUpdatePlan["currentClaw"]>;
  targetClaw: NonNullable<ClawUpdatePlan["targetClaw"]>;
  appliedActions: ClawUpdateAction[];
  installRecord: PersistedClawInstall;
};

function comparablePlan(plan: ClawUpdatePlan): unknown {
  return {
    found: plan.found,
    agentId: plan.agentId,
    currentClaw: plan.currentClaw,
    targetClaw: plan.targetClaw,
    actions: plan.actions,
    blockers: plan.blockers,
  };
}

export async function applyClawUpdatePlan(
  plan: ClawUpdatePlan,
  params: {
    targetManifest: ClawManifest;
    targetSource: ClawSourceIdentity;
  },
  options: OpenClawStateDatabaseOptions & {
    config: OpenClawConfig;
    commitConfig?: ConfigCommit;
    rebuildPlan?: typeof buildClawUpdatePlan;
    buildAddPlan?: typeof buildClawAddPlan;
    readInstall?: typeof readClawInstallRecord;
    persistInstall?: typeof updateClawInstallRecord;
    applyWorkspace?: typeof applyClawWorkspaceUpdate;
    applyMcp?: typeof applyClawMcpUpdate;
    applyCron?: typeof applyClawCronUpdate;
    applyPackage?: typeof applyClawPackageUpdate;
    cronGateway?: ClawCronGateway;
  },
): Promise<ClawUpdateResult> {
  if (!plan.found || plan.blockers.length > 0 || plan.actions.some((action) => action.blocked)) {
    throw new ClawUpdateMutationError(
      "update_blocked",
      "The Claw update plan contains blockers or manual actions.",
    );
  }

  const rebuildPlan = options.rebuildPlan ?? buildClawUpdatePlan;
  const fresh = await rebuildPlan({
    agentId: plan.agentId,
    targetManifest: params.targetManifest,
    targetSource: params.targetSource,
    config: options.config,
    stateOptions: options,
  });
  if (stableStringify(comparablePlan(fresh)) !== stableStringify(comparablePlan(plan))) {
    throw new ClawUpdateMutationError(
      "update_changed",
      "Claw-owned state changed after update planning; build a new dry-run plan.",
    );
  }

  const actionable = fresh.actions.filter((action) => action.action !== "unchanged");
  const unsupported = actionable.filter(
    (action) =>
      action.kind !== "agent" &&
      action.kind !== "workspaceFile" &&
      action.kind !== "mcpServer" &&
      action.kind !== "cronJob" &&
      action.kind !== "package",
  );
  if (unsupported.length > 0) {
    throw new ClawUpdateMutationError(
      "unsupported_update_actions",
      `This update slice cannot yet apply: ${unsupported.map((action) => `${action.kind}:${action.id}`).join(", ")}.`,
    );
  }
  if (!fresh.currentClaw || !fresh.targetClaw) {
    throw new ClawUpdateMutationError("update_invalid", "The Claw update plan lacks identity.");
  }

  const buildAddPlan = options.buildAddPlan ?? buildClawAddPlan;
  const readInstall = options.readInstall ?? readClawInstallRecord;
  const currentInstall = readInstall(fresh.agentId, options);
  if (!currentInstall) {
    throw new ClawUpdateMutationError("update_changed", "The Claw install record disappeared.");
  }
  const targetAddPlan = await buildAddPlan({
    manifest: params.targetManifest,
    source: params.targetSource,
    context: { agentId: fresh.agentId, workspace: currentInstall.workspace },
  });
  if (
    targetAddPlan.blockers.some(
      (blocker) => blocker.code !== "agent_id_collision" && blocker.code !== "workspace_collision",
    )
  ) {
    throw new ClawUpdateMutationError(
      "update_target_blocked",
      "The target Claw cannot be safely materialized for update.",
    );
  }

  const applyWorkspace = options.applyWorkspace ?? applyClawWorkspaceUpdate;
  let workspaceExecution: ClawWorkspaceUpdateExecution;
  try {
    workspaceExecution = await applyWorkspace(fresh, targetAddPlan, options);
  } catch (error) {
    if (error instanceof ClawWorkspaceUpdateError && error.partial) {
      throw new ClawUpdateMutationError("update_partial", error.message);
    }
    throw new ClawUpdateMutationError(
      "workspace_update_failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  const applyMcp = options.applyMcp ?? applyClawMcpUpdate;
  let mcpExecution: ClawMcpUpdateExecution;
  try {
    mcpExecution = await applyMcp(fresh, params.targetManifest, options);
  } catch (error) {
    const partial = error instanceof ClawMcpUpdateError && error.partial;
    try {
      await workspaceExecution.rollback();
    } catch (rollbackError) {
      throw new ClawUpdateMutationError(
        "update_partial",
        `${error instanceof Error ? error.message : String(error)}; workspace rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    if (partial) {
      throw new ClawUpdateMutationError(
        "update_partial",
        `${error.message}; MCP config write outcome is uncertain`,
      );
    }
    throw new ClawUpdateMutationError(
      "mcp_update_failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  const applyCron = options.applyCron ?? applyClawCronUpdate;
  let cronExecution: ClawCronUpdateExecution;
  try {
    cronExecution = await applyCron(fresh, params.targetManifest, options);
  } catch (error) {
    const rollbackFailures: string[] = [];
    try {
      await mcpExecution.rollback();
    } catch (rollbackError) {
      rollbackFailures.push(
        `MCP rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    if (error instanceof ClawCronUpdateError && error.partial) {
      rollbackFailures.unshift("cron gateway mutation outcome is uncertain");
    }
    try {
      await workspaceExecution.rollback();
    } catch (rollbackError) {
      rollbackFailures.push(
        `workspace rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    if (rollbackFailures.length > 0) {
      throw new ClawUpdateMutationError(
        "update_partial",
        `${error instanceof Error ? error.message : String(error)}; ${rollbackFailures.join("; ")}`,
      );
    }
    throw new ClawUpdateMutationError(
      "cron_update_failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  const applyPackage = options.applyPackage ?? applyClawPackageUpdate;
  let packageExecution: ClawPackageUpdateExecution;
  try {
    packageExecution = await applyPackage(fresh, params.targetManifest, targetAddPlan, options);
  } catch (error) {
    const rollbackFailures: string[] = [];
    try {
      await cronExecution.rollback();
    } catch (rollbackError) {
      rollbackFailures.push(
        `cron rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    try {
      await mcpExecution.rollback();
    } catch (rollbackError) {
      rollbackFailures.push(
        `MCP rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    try {
      await workspaceExecution.rollback();
    } catch (rollbackError) {
      rollbackFailures.push(
        `workspace rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    if (error instanceof ClawPackageUpdateError && error.partial) {
      rollbackFailures.unshift("package artifact rollback is unavailable");
    }
    if (rollbackFailures.length > 0) {
      throw new ClawUpdateMutationError(
        "update_partial",
        `${error instanceof Error ? error.message : String(error)}; ${rollbackFailures.join("; ")}`,
      );
    }
    throw new ClawUpdateMutationError(
      "package_update_failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  const agentAction = fresh.actions.find((action) => action.kind === "agent");
  const commit: ConfigCommit =
    options.commitConfig ??
    (async (transform) => {
      await transformConfigFileWithRetry({
        afterWrite: { mode: "auto" },
        transform: (config) => ({ nextConfig: transform(config) }),
      });
    });
  let previousAgent: NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number] | undefined;
  let agentChanged = false;
  const rollbackAgent = async (): Promise<void> => {
    if (!agentChanged) {
      return;
    }
    await commit((config) => {
      const agents = config.agents?.list ?? [];
      const index = agents.findIndex((agent) => agent.id === fresh.agentId);
      const current = index >= 0 ? agents[index] : undefined;
      const targetDigest = `sha256:${createHash("sha256").update(stableStringify(targetAddPlan.agent.config)).digest("hex")}`;
      const liveDigest = current
        ? `sha256:${createHash("sha256").update(stableStringify(current)).digest("hex")}`
        : undefined;
      if (liveDigest !== targetDigest) {
        throw new Error("The agent changed before rollback.");
      }
      const nextAgents = agents.filter((agent) => agent.id !== fresh.agentId);
      if (previousAgent) {
        nextAgents.splice(index, 0, previousAgent);
      }
      return { ...config, agents: { ...config.agents, list: nextAgents } };
    });
    agentChanged = false;
  };
  if (agentAction?.action === "change") {
    try {
      await commit((config) => {
        const agents = config.agents?.list ?? [];
        const index = agents.findIndex((agent) => agent.id === fresh.agentId);
        const current = index >= 0 ? agents[index] : undefined;
        previousAgent = current;
        if (current && agentAction.currentDigest !== undefined) {
          const liveDigest = `sha256:${createHash("sha256").update(stableStringify(current)).digest("hex")}`;
          if (liveDigest !== agentAction.currentDigest) {
            throw new ClawUpdateMutationError(
              "agent_changed",
              "The owned agent entry changed during update.",
            );
          }
        }
        const nextAgents = [...agents];
        if (index >= 0) {
          nextAgents[index] = targetAddPlan.agent.config;
        } else {
          nextAgents.push(targetAddPlan.agent.config);
        }
        agentChanged = true;
        return { ...config, agents: { ...config.agents, list: nextAgents } };
      });
    } catch (error) {
      const rollbackFailures: string[] = [];
      try {
        await rollbackAgent();
      } catch (rollbackError) {
        rollbackFailures.push(
          `agent rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      try {
        await packageExecution.rollback();
      } catch (rollbackError) {
        rollbackFailures.push(
          `package rollback incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      try {
        await cronExecution.rollback();
      } catch (rollbackError) {
        rollbackFailures.push(
          `cron rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      try {
        await mcpExecution.rollback();
      } catch (rollbackError) {
        rollbackFailures.push(
          `MCP rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      try {
        await workspaceExecution.rollback();
      } catch (rollbackError) {
        rollbackFailures.push(
          `workspace rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      if (rollbackFailures.length > 0) {
        throw new ClawUpdateMutationError(
          "update_partial",
          `${error instanceof Error ? error.message : String(error)}; ${rollbackFailures.join("; ")}`,
        );
      }
      if (error instanceof ClawUpdateMutationError) {
        throw error;
      }
      throw new ClawUpdateMutationError(
        "agent_update_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const persistInstall = options.persistInstall ?? updateClawInstallRecord;
  let installRecord: PersistedClawInstall;
  try {
    installRecord = persistInstall(targetAddPlan, {
      ...options,
      expectedClaw: fresh.currentClaw,
    });
  } catch (error) {
    const rollbackFailures: string[] = [];
    try {
      await rollbackAgent();
    } catch (rollbackError) {
      rollbackFailures.push(
        `agent rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    try {
      await packageExecution.rollback();
    } catch (rollbackError) {
      rollbackFailures.push(
        `package rollback incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    try {
      await cronExecution.rollback();
    } catch (rollbackError) {
      rollbackFailures.push(
        `cron rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    try {
      await mcpExecution.rollback();
    } catch (rollbackError) {
      rollbackFailures.push(
        `MCP rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    try {
      await workspaceExecution.rollback();
    } catch (rollbackError) {
      rollbackFailures.push(
        `workspace rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    if (rollbackFailures.length > 0) {
      throw new ClawUpdateMutationError(
        "update_partial",
        `${error instanceof Error ? error.message : String(error)}; ${rollbackFailures.join("; ")}`,
      );
    }
    throw new ClawUpdateMutationError(
      "provenance_update_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    schemaVersion: CLAW_UPDATE_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    mutationAllowed: true,
    status: "complete",
    agentId: fresh.agentId,
    previousClaw: fresh.currentClaw,
    targetClaw: fresh.targetClaw,
    appliedActions: actionable,
    installRecord,
  };
}
