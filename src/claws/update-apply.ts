import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { coerceErrorMessage, stableStringify } from "@openclaw/normalization-core";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import { transformConfigFileWithRetry } from "../config/config.js";
import { applyConfigOverrides } from "../config/runtime-overrides.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import type { RuntimeEnv } from "../runtime.js";
import { updateClawInstallRecordStatusForAdd } from "./add-state-write.js";
import {
  digestClawOwnedAgentConfig,
  matchesClawAgentConfigDigest,
  preserveOperatorAgentSettings,
} from "./agent-config-ownership.js";
import {
  applyClawCronUpdate,
  ClawCronUpdateError,
  type ClawCronUpdateExecution,
} from "./cron-update.js";
import type { ClawCronGateway } from "./cron.js";
import { readClawInventory } from "./inventory-read.js";
import { buildClawAddPlan, type ClawAddPlanContext } from "./lifecycle.js";
import {
  applyClawMcpUpdate,
  ClawMcpUpdateError,
  type ClawMcpUpdateExecution,
} from "./mcp-update.js";
import { normalizeWorkspaceConfig, resolveMigrationAgentSettings } from "./migrate-validation.js";
import type { PackageRemovalDeps } from "./package-remove.js";
import {
  applyClawPackageUpdate,
  ClawPackageUpdateError,
  type ClawPackageUpdateExecution,
} from "./package-update.js";
import type { ClawPluginInstallConsent, ClawSkillInstallConsent } from "./packages.js";
import { runClawPluginBatch, type ClawPluginRuntimeOptions } from "./plugin-runtime.js";
import {
  readClawInstallRecord,
  updateClawInstallRecord,
  type PersistedClawInstall,
} from "./provenance.js";
import {
  CLAW_OUTPUT_STABILITY,
  type ClawManifest,
  type ClawOpenClawProfile,
  type ClawSourceIdentity,
} from "./types.js";
import {
  comparableUpdatePlan,
  inspectUpdatePluginRequirements,
  inspectUpdateTargetPackages,
  updatePackagePreflight,
} from "./update-apply-preflight.js";
import { buildClawUpdatePlan, type ClawUpdateAction, type ClawUpdatePlan } from "./update-plan.js";
import { collectClawRollbackFailures } from "./update-rollback.js";
import {
  persistClawInstallRecordForUpdate,
  readClawInstallRecordForUpdate,
  type ClawUpdateStateOptions,
} from "./update-state-write.js";
import {
  applyClawWorkspaceUpdate,
  ClawWorkspaceUpdateError,
  type ClawWorkspaceUpdateExecution,
} from "./workspace-update.js";

export const CLAW_UPDATE_RESULT_SCHEMA_VERSION = "openclaw.clawUpdateResult.v1" as const;

type ConfigCommit = (
  transform: (config: OpenClawConfig, runtimeConfig: OpenClawConfig) => OpenClawConfig,
  beforeCommit?: () => void,
) => Promise<void>;

export class ClawUpdateMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClawUpdateMutationError";
  }
}

type ClawUpdateResult = {
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

type ClawUpdateTarget = {
  targetManifest: ClawManifest;
  targetClawMarkdownBody?: Buffer;
  targetOpenClawProfile?: ClawOpenClawProfile;
  targetSource: ClawSourceIdentity;
};

export type ClawUpdateApplyOptions = ClawUpdateStateOptions & {
  config: OpenClawConfig;
  getCurrentConfig?: () => OpenClawConfig;
  assertReviewedConfig?: (
    config: OpenClawConfig,
    desiredAgent: AgentConfig,
    phase?: "after-agent-commit",
  ) => void;
  sourceMcpServers: Record<string, Record<string, unknown>>;
  clawHubBaseUrl?: string;
  planPackageDeps?: PackageRemovalDeps;
  consentPlanIntegrity: string | undefined;
  packagePreflight?: ClawAddPlanContext["packagePreflight"];
  runtime?: RuntimeEnv;
  runtimeBatch?: ClawPluginRuntimeOptions["runtimeBatch"];
  pluginConsent?: ClawPluginInstallConsent;
  skillConsent?: ClawSkillInstallConsent;
  reloadPlugins?: PluginInstallBatchReload;
  commitConfig?: ConfigCommit;
  rebuildPlan?: typeof buildClawUpdatePlan;
  buildAddPlan?: typeof buildClawAddPlan;
  readInstall?: (
    agentId: Parameters<typeof readClawInstallRecord>[0],
    options?: Parameters<typeof readClawInstallRecord>[1],
  ) => ReturnType<typeof readClawInstallRecord> | Promise<ReturnType<typeof readClawInstallRecord>>;
  persistInstall?: (
    plan: Parameters<typeof updateClawInstallRecord>[0],
    options?: Parameters<typeof updateClawInstallRecord>[1],
  ) => PersistedClawInstall | Promise<PersistedClawInstall>;
  applyWorkspace?: typeof applyClawWorkspaceUpdate;
  applyMcp?: typeof applyClawMcpUpdate;
  applyCron?: typeof applyClawCronUpdate;
  applyPackage?: typeof applyClawPackageUpdate;
  cronGateway?: ClawCronGateway;
};

type ClawUpdateHostRequirementsStage = {
  needsRuntimeHandoff: boolean;
  requiredPluginIds: readonly string[];
  continue(nextOptions?: ClawUpdateApplyOptions): Promise<ClawUpdateResult>;
  failRuntime(error: unknown): Promise<never>;
};

export async function applyClawUpdatePlan(
  plan: ClawUpdatePlan,
  params: ClawUpdateTarget,
  options: ClawUpdateApplyOptions,
): Promise<ClawUpdateResult> {
  const staged = await stageClawUpdateHostRequirements(plan, params, options);
  return await staged.continue();
}

/** Stages shared plugins before the Gateway releases its lease for runtime activation. */
export async function stageClawUpdateHostRequirements(
  plan: ClawUpdatePlan,
  params: ClawUpdateTarget,
  initialOptions: ClawUpdateApplyOptions,
): Promise<ClawUpdateHostRequirementsStage> {
  let options = initialOptions;
  if (options.consentPlanIntegrity !== plan.planIntegrity) {
    throw new ClawUpdateMutationError(
      "plan_integrity_mismatch",
      "Consent does not match the current Claw update plan; run update --dry-run again.",
    );
  }
  if (!plan.found || plan.blockers.length > 0 || plan.actions.some((action) => action.blocked)) {
    throw new ClawUpdateMutationError(
      "update_blocked",
      "The Claw update plan contains blockers or manual actions.",
    );
  }

  const rebuildPlan = options.rebuildPlan ?? buildClawUpdatePlan;
  const rebuildCurrentPlan = async (config: OpenClawConfig) => {
    options.assertCurrent?.();
    const inventory = options.stateMode === "worker" ? await readClawInventory(options) : undefined;
    options.assertCurrent?.();
    const current = await rebuildPlan({
      agentId: plan.agentId,
      targetManifest: params.targetManifest,
      targetClawMarkdownBody: params.targetClawMarkdownBody,
      targetOpenClawProfile: params.targetOpenClawProfile,
      targetSource: params.targetSource,
      diagnostics: plan.diagnostics,
      config,
      sourceMcpServers: options.sourceMcpServers,
      ...(inventory ? { inventory, exactAgentId: true } : {}),
      stateOptions:
        options.stateMode === "worker"
          ? { ...options, readOnly: true, packageDeps: options.planPackageDeps }
          : options,
      packagePreflight: options.packagePreflight,
    });
    options.assertCurrent?.();
    return current;
  };
  const fresh = await rebuildCurrentPlan(options.config);
  if (
    fresh.planIntegrity !== plan.planIntegrity ||
    stableStringify(comparableUpdatePlan(fresh)) !== stableStringify(comparableUpdatePlan(plan))
  ) {
    throw new ClawUpdateMutationError(
      "update_changed",
      "Claw-owned state changed after update planning; build a new dry-run plan.",
    );
  }

  const actionable = fresh.actions.filter((action) => action.action !== "unchanged");
  const previousClaw = fresh.currentClaw;
  const targetClaw = fresh.targetClaw;
  if (!previousClaw || !targetClaw) {
    throw new ClawUpdateMutationError("update_invalid", "The Claw update plan lacks identity.");
  }

  const buildAddPlan = options.buildAddPlan ?? buildClawAddPlan;
  const readInstall = options.readInstall ?? readClawInstallRecordForUpdate;
  const currentInstall = await readInstall(fresh.agentId, options);
  options.assertCurrent?.();
  if (!currentInstall) {
    throw new ClawUpdateMutationError("update_changed", "The Claw install record disappeared.");
  }
  const adoptedAgentConfigDigest =
    currentInstall.agentOrigin === "adopted"
      ? fresh.actions.find((action) => action.kind === "agent")?.desiredDigest
      : undefined;
  if (currentInstall.agentOrigin === "adopted" && !adoptedAgentConfigDigest) {
    throw new ClawUpdateMutationError("update_changed", "Adopted agent authority is unavailable.");
  }
  const partialMutation = async (
    message: string,
    errorOptions?: ErrorOptions,
  ): Promise<ClawUpdateMutationError> => {
    try {
      await updateClawInstallRecordStatusForAdd(fresh.agentId, "partial", options);
    } catch {
      // Preserve the owner failure; doctor can still reconcile subordinate pending records.
    }
    return new ClawUpdateMutationError("update_partial", message, errorOptions);
  };
  const targetAddPlan = await buildAddPlan({
    manifest: params.targetManifest,
    clawMarkdownBody: params.targetClawMarkdownBody,
    includePackageBootstrap: false,
    openClawProfile: params.targetOpenClawProfile,
    source: params.targetSource,
    context: {
      config: options.config,
      agentId: fresh.agentId,
      workspace: currentInstall.workspace,
      packagePreflight: updatePackagePreflight(fresh, options.packagePreflight),
    },
  });
  options.assertCurrent?.();
  const packageCheck = inspectUpdateTargetPackages({
    plan: fresh,
    addPlan: targetAddPlan,
    manifest: params.targetManifest,
    profile: params.targetOpenClawProfile,
  });
  if (!packageCheck.ok) {
    throw new ClawUpdateMutationError(packageCheck.code, packageCheck.message);
  }
  const targetPackages = packageCheck.targetPackages;

  const assertReviewedCurrent = (phase?: "after-agent-commit") => {
    if (!options.getCurrentConfig || !options.assertReviewedConfig) {
      return;
    }
    options.assertCurrent?.();
    const config = options.getCurrentConfig();
    if (phase) {
      options.assertReviewedConfig(config, targetAddPlan.agent.config, phase);
    } else {
      options.assertReviewedConfig(config, targetAddPlan.agent.config);
    }
    options.assertCurrent?.();
  };
  const assertForwardCurrent = (phase?: "after-agent-commit") => {
    options.assertCurrent?.();
    options.assertForwardCurrent?.();
    assertReviewedCurrent(phase);
  };
  const preCommitOptions = () => ({
    ...options,
    assertForwardCurrent: () => assertForwardCurrent(),
  });

  const applyPackage = options.applyPackage ?? applyClawPackageUpdate;
  const requirementActions = fresh.actions.filter(
    (action) =>
      action.kind === "package" &&
      action.action !== "unchanged" &&
      action.action !== "release" &&
      action.action !== "remove" &&
      targetPackages.get(action.id)?.kind === "plugin",
  );
  const remainingPackageActions = fresh.actions.filter(
    (action) =>
      action.kind === "package" &&
      action.action !== "unchanged" &&
      !requirementActions.includes(action),
  );
  const applyPackageActions = async (
    actions: ClawUpdateAction[],
    runtimeBatch?: ClawPluginRuntimeOptions["runtimeBatch"],
  ): Promise<ClawPackageUpdateExecution> => {
    if (actions.length === 0) {
      return { appliedIds: [], rollback: async () => undefined };
    }
    assertReviewedCurrent();
    options.assertCurrent?.();
    return await applyPackage({ ...fresh, actions }, targetAddPlan, {
      ...preCommitOptions(),
      runtimeBatch,
    });
  };
  const requirementIds = inspectUpdatePluginRequirements({
    plan: fresh,
    addPlan: targetAddPlan,
    targetPackages,
    requirementActions,
    resume: currentInstall.status !== "complete",
    captureOwners: Boolean(options.runtimeBatch),
  });
  if (!requirementIds.ok) {
    throw new ClawUpdateMutationError("update_changed", requirementIds.message);
  }
  const { resumedRequirements, requiredPluginIds } = requirementIds;

  let requirementExecution: ClawPackageUpdateExecution;
  try {
    assertReviewedCurrent();
    requirementExecution =
      requirementActions.length || resumedRequirements.length
        ? await runClawPluginBatch(
            preCommitOptions(),
            requirementActions.length + resumedRequirements.length,
            (batch) => {
              for (const id of resumedRequirements) {
                batch?.retain(id);
              }
              return applyPackageActions(requirementActions, batch);
            },
            (failure, operation) =>
              new ClawPackageUpdateError(
                [
                  !operation.ok ? coerceErrorMessage(operation.error) : undefined,
                  coerceErrorMessage(failure),
                ]
                  .filter(Boolean)
                  .join("\n"),
                true,
                { cause: !operation.ok ? new AggregateError([operation.error, failure]) : failure },
              ),
          )
        : await applyPackageActions(requirementActions);
  } catch (error) {
    if (error instanceof ClawPackageUpdateError && error.partial) {
      throw await partialMutation(error.message, { cause: error });
    }
    if (options.runtimeBatch?.hasCommitted) {
      throw await partialMutation(coerceErrorMessage(error), { cause: error });
    }
    if (error instanceof ClawUpdateMutationError) {
      throw error;
    }
    throw new ClawUpdateMutationError("package_update_failed", coerceErrorMessage(error), {
      cause: error,
    });
  }
  const retainedRequirementMutation = requirementExecution.appliedIds.length > 0;
  const throwIfUpdatePartial = async (
    error: unknown,
    rollbackFailures: string[] = [],
  ): Promise<void> => {
    if (rollbackFailures.length > 0) {
      throw await partialMutation(`${coerceErrorMessage(error)}; ${rollbackFailures.join("; ")}`);
    }
    if (retainedRequirementMutation) {
      throw await partialMutation(
        `${coerceErrorMessage(error)}; successfully realized shared requirements were retained`,
      );
    }
  };

  const needsRuntimeHandoff = Boolean(
    options.runtimeBatch && (requirementActions.length || resumedRequirements.length),
  );
  let postRequirementPlan: ClawUpdatePlan | undefined;
  if (needsRuntimeHandoff) {
    try {
      assertReviewedCurrent();
      postRequirementPlan = await rebuildCurrentPlan(
        options.getCurrentConfig?.() ?? options.config,
      );
    } catch (error) {
      await throwIfUpdatePartial(error);
      throw error;
    }
  }

  let continued = false;
  const failRuntime = async (error: unknown): Promise<never> => {
    if (continued) {
      throw new Error("Claw update host requirements already continued");
    }
    continued = true;
    throw await partialMutation(coerceErrorMessage(error), { cause: error });
  };
  const continueUpdate = async (
    nextOptions: ClawUpdateApplyOptions = options,
  ): Promise<ClawUpdateResult> => {
    if (continued) {
      throw new Error("Claw update host requirements already continued");
    }
    continued = true;
    options = nextOptions;
    if (postRequirementPlan) {
      try {
        assertReviewedCurrent();
        const current = await rebuildCurrentPlan(options.getCurrentConfig?.() ?? options.config);
        if (
          stableStringify(comparableUpdatePlan(current)) !==
          stableStringify(comparableUpdatePlan(postRequirementPlan))
        ) {
          throw new ClawUpdateMutationError(
            "update_changed",
            "Claw-owned state changed during plugin activation; build a new dry-run plan.",
          );
        }
      } catch (error) {
        await throwIfUpdatePartial(error);
        throw error;
      }
    }
    const installPersistenceOptions = {
      ...options,
      ...(adoptedAgentConfigDigest ? { agentConfigDigest: adoptedAgentConfigDigest } : {}),
    };

    const applyWorkspace = options.applyWorkspace ?? applyClawWorkspaceUpdate;
    let workspaceExecution: ClawWorkspaceUpdateExecution;
    try {
      assertReviewedCurrent();
      workspaceExecution = await applyWorkspace(fresh, targetAddPlan, preCommitOptions());
    } catch (error) {
      if (error instanceof ClawWorkspaceUpdateError && error.partial) {
        throw await partialMutation(error.message);
      }
      await throwIfUpdatePartial(error);
      if (error instanceof ClawUpdateMutationError) {
        throw error;
      }
      throw new ClawUpdateMutationError("workspace_update_failed", coerceErrorMessage(error));
    }

    const applyMcp = options.applyMcp ?? applyClawMcpUpdate;
    let mcpExecution: ClawMcpUpdateExecution;
    try {
      assertReviewedCurrent();
      mcpExecution = await applyMcp(fresh, params.targetManifest, preCommitOptions());
    } catch (error) {
      const partial = error instanceof ClawMcpUpdateError && error.partial;
      try {
        await workspaceExecution.rollback();
      } catch (rollbackError) {
        throw await partialMutation(
          `${coerceErrorMessage(error)}; workspace rollback failed: ${coerceErrorMessage(rollbackError)}`,
        );
      }
      if (partial) {
        throw await partialMutation(`${error.message}; MCP config write outcome is uncertain`);
      }
      await throwIfUpdatePartial(error);
      if (error instanceof ClawUpdateMutationError) {
        throw error;
      }
      throw new ClawUpdateMutationError("mcp_update_failed", coerceErrorMessage(error));
    }

    let packageExecution: ClawPackageUpdateExecution;
    try {
      packageExecution = await applyPackageActions(remainingPackageActions);
    } catch (error) {
      // Keep method lookup and receiver binding inside each step.
      const rollbackFailures = await collectClawRollbackFailures([
        ["MCP rollback failed", () => mcpExecution.rollback()],
        ["workspace rollback failed", () => workspaceExecution.rollback()],
      ]);
      if (error instanceof ClawPackageUpdateError && error.partial) {
        rollbackFailures.unshift("package artifact rollback is unavailable");
      }
      await throwIfUpdatePartial(error, rollbackFailures);
      if (error instanceof ClawUpdateMutationError) {
        throw error;
      }
      throw new ClawUpdateMutationError("package_update_failed", coerceErrorMessage(error));
    }

    const agentAction = fresh.actions.find((action) => action.kind === "agent");
    const commit: ConfigCommit =
      options.commitConfig ??
      (async (transform, beforeCommit) => {
        await transformConfigFileWithRetry({
          afterWrite: { mode: "auto" },
          writeOptions: { assertCurrent: options.assertCurrent, beforeCommit },
          transform: (config, context) => ({
            nextConfig: transform(config, context.snapshot.runtimeConfig),
          }),
        });
      });
    let previousAgent: AgentConfig | undefined;
    let agentChanged = false;
    const liveAgentMatchesDigest = (
      config: OpenClawConfig,
      agent: AgentConfig | undefined,
      expectedDigest: string,
    ) => {
      if (!agent) {
        return false;
      }
      if (currentInstall.agentOrigin !== "adopted") {
        return matchesClawAgentConfigDigest(agent, expectedDigest);
      }
      let workspace = resolveAgentWorkspaceDir(config, fresh.agentId, options.env);
      try {
        workspace = realpathSync(workspace);
      } catch {
        workspace = resolve(workspace);
      }
      try {
        // Compare the effective authored agent while leaving operator model and
        // delegation settings outside Claw ownership.
        return matchesClawAgentConfigDigest(
          normalizeWorkspaceConfig(resolveMigrationAgentSettings(config, agent), workspace),
          expectedDigest,
        );
      } catch {
        return false;
      }
    };
    const rollbackAgent = async (): Promise<void> => {
      if (!agentChanged) {
        return;
      }
      options.assertCurrent?.();
      await commit((config) => {
        options.assertCurrent?.();
        const current = listAgentEntries(config).find((agent) => agent.id === fresh.agentId);
        const targetDigest =
          currentInstall.agentOrigin === "adopted"
            ? adoptedAgentConfigDigest
            : digestClawOwnedAgentConfig(targetAddPlan.agent.config);
        if (!targetDigest || !liveAgentMatchesDigest(config, current, targetDigest)) {
          throw new Error("The agent changed before rollback.");
        }
        const nextEntries = { ...config.agents?.entries };
        if (previousAgent) {
          const { id: _id, ...previousEntry } = preserveOperatorAgentSettings(
            previousAgent,
            current,
          );
          nextEntries[fresh.agentId] = previousEntry;
        } else {
          delete nextEntries[fresh.agentId];
        }
        return { ...config, agents: { ...config.agents, entries: nextEntries } };
      });
      agentChanged = false;
    };
    if (agentAction?.action === "change") {
      try {
        options.assertCurrent?.();
        await commit(
          (config, runtimeConfig) => {
            options.assertCurrent?.();
            options.assertReviewedConfig?.(
              applyConfigOverrides(runtimeConfig),
              targetAddPlan.agent.config,
            );
            const current = listAgentEntries(config).find((agent) => agent.id === fresh.agentId);
            previousAgent = current;
            if (agentAction.currentDigest !== undefined) {
              if (!current) {
                throw new ClawUpdateMutationError(
                  "agent_changed",
                  "The owned agent entry disappeared during update.",
                );
              }
              if (!liveAgentMatchesDigest(config, current, agentAction.currentDigest)) {
                throw new ClawUpdateMutationError(
                  "agent_changed",
                  "The owned agent entry changed during update.",
                );
              }
            }
            const nextEntries = { ...config.agents?.entries };
            const { id: _id, ...targetEntry } = preserveOperatorAgentSettings(
              targetAddPlan.agent.config,
              current,
            );
            nextEntries[fresh.agentId] = targetEntry;
            agentChanged = true;
            return { ...config, agents: { ...config.agents, entries: nextEntries } };
          },
          () => {
            try {
              assertForwardCurrent();
            } catch (error) {
              // A rejected pre-rename check has not changed the agent entry.
              agentChanged = false;
              throw error;
            }
          },
        );
      } catch (error) {
        const rollbackFailures = await collectClawRollbackFailures([
          ["agent rollback failed", () => rollbackAgent()],
          ["package rollback incomplete", () => packageExecution.rollback()],
          ["MCP rollback failed", () => mcpExecution.rollback()],
          ["workspace rollback failed", () => workspaceExecution.rollback()],
        ]);
        await throwIfUpdatePartial(error, rollbackFailures);
        if (error instanceof ClawUpdateMutationError) {
          throw error;
        }
        throw new ClawUpdateMutationError("agent_update_failed", coerceErrorMessage(error));
      }
    }

    const persistInstall = options.persistInstall ?? persistClawInstallRecordForUpdate;
    const applyCron = options.applyCron ?? applyClawCronUpdate;
    const postCommitPhase = agentAction?.action === "change" ? "after-agent-commit" : undefined;
    let cronExecution: ClawCronUpdateExecution;
    try {
      assertReviewedCurrent(postCommitPhase);
      cronExecution = await applyCron(fresh, params.targetManifest, {
        ...options,
        assertForwardCurrent: () => assertForwardCurrent(postCommitPhase),
      });
    } catch (error) {
      if (error instanceof ClawCronUpdateError && error.partial) {
        try {
          await persistInstall(targetAddPlan, {
            ...installPersistenceOptions,
            expectedClaw: fresh.currentClaw,
            status: "partial",
          });
        } catch (persistError) {
          throw await partialMutation(
            `${error.message}; cron gateway mutation outcome is uncertain; provenance update failed: ${coerceErrorMessage(persistError)}`,
          );
        }
        throw await partialMutation(`${error.message}; cron gateway mutation outcome is uncertain`);
      }
      const rollbackFailures = await collectClawRollbackFailures([
        ["agent rollback failed", () => rollbackAgent()],
        ["package rollback incomplete", () => packageExecution.rollback()],
        ["MCP rollback failed", () => mcpExecution.rollback()],
        ["workspace rollback failed", () => workspaceExecution.rollback()],
      ]);
      await throwIfUpdatePartial(error, rollbackFailures);
      if (error instanceof ClawUpdateMutationError) {
        throw error;
      }
      throw new ClawUpdateMutationError("cron_update_failed", coerceErrorMessage(error));
    }

    let installRecord: PersistedClawInstall;
    try {
      assertReviewedCurrent(postCommitPhase);
      installRecord = await persistInstall(targetAddPlan, {
        ...installPersistenceOptions,
        assertCurrent: () => assertForwardCurrent(postCommitPhase),
        expectedClaw: fresh.currentClaw,
      });
    } catch (error) {
      const rollbackFailures = await collectClawRollbackFailures([
        ["agent rollback failed", () => rollbackAgent()],
        ["package rollback incomplete", () => packageExecution.rollback()],
        ["cron rollback failed", () => cronExecution.rollback()],
        ["MCP rollback failed", () => mcpExecution.rollback()],
        ["workspace rollback failed", () => workspaceExecution.rollback()],
      ]);
      await throwIfUpdatePartial(error, rollbackFailures);
      if (error instanceof ClawUpdateMutationError) {
        throw error;
      }
      throw new ClawUpdateMutationError("provenance_update_failed", coerceErrorMessage(error));
    }
    try {
      await packageExecution.commit?.(() => assertForwardCurrent(postCommitPhase));
    } catch (error) {
      throw await partialMutation(
        `Claw update committed, but skill backup cleanup failed: ${coerceErrorMessage(error)}`,
      );
    }
    return {
      schemaVersion: CLAW_UPDATE_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      mutationAllowed: true,
      status: "complete",
      agentId: fresh.agentId,
      previousClaw,
      targetClaw,
      appliedActions: actionable,
      installRecord,
    };
  };
  return { needsRuntimeHandoff, requiredPluginIds, continue: continueUpdate, failRuntime };
}
