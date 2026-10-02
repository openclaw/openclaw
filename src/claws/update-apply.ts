import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { coerceErrorMessage, stableStringify } from "@openclaw/normalization-core";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import { transformConfigFileWithRetry } from "../config/config.js";
import { applyConfigOverrides } from "../config/runtime-overrides.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import type { RuntimeEnv } from "../runtime.js";
import { updateClawInstallRecordStatusForAdd } from "./add-state-write.js";
import {
  digestClawOwnedAgentConfig,
  matchesClawAgentConfigDigest,
  preserveOperatorAgentSettings,
} from "./agent-config-ownership.js";
import { clawTargetPackages } from "./application-provenance.js";
import {
  applyClawCronUpdate,
  ClawCronUpdateError,
  type ClawCronUpdateExecution,
} from "./cron-update.js";
import type { ClawCronGateway } from "./cron.js";
import { digestClawValue as digest } from "./digest.js";
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

function comparablePlan(plan: ClawUpdatePlan): unknown {
  return {
    found: plan.found,
    agentId: plan.agentId,
    currentClaw: plan.currentClaw,
    targetClaw: plan.targetClaw,
    actions: plan.actions,
    capabilityChanges: plan.capabilityChanges,
    readiness: plan.readiness,
    blockers: plan.blockers,
  };
}

function unchangedPackagePaths(plan: ClawUpdatePlan, manifest: ClawManifest): Set<string> {
  const unchangedIds = new Set(
    plan.actions
      .filter((action) => action.kind === "package" && action.action === "unchanged")
      .map((action) => action.id),
  );
  const paths = new Set<string>();
  manifest.packages.forEach((pkg, index) => {
    if (unchangedIds.has(`${pkg.kind}:${pkg.ref}`)) {
      paths.add(`$.packages[${index}]`);
    }
  });
  return paths;
}

export async function applyClawUpdatePlan(
  plan: ClawUpdatePlan,
  params: {
    targetManifest: ClawManifest;
    targetClawMarkdownBody?: Buffer;
    targetOpenClawProfile?: ClawOpenClawProfile;
    targetSource: ClawSourceIdentity;
  },
  options: ClawUpdateStateOptions & {
    config: OpenClawConfig;
    getCurrentConfig?: () => OpenClawConfig;
    assertReviewedConfig?: (
      config: OpenClawConfig,
      desiredAgent: AgentConfig,
      phase?: "after-agent-commit",
    ) => void;
    sourceMcpServers: Record<string, Record<string, unknown>>;
    planPackageDeps?: PackageRemovalDeps;
    consentPlanIntegrity: string | undefined;
    packagePreflight?: ClawAddPlanContext["packagePreflight"];
    runtime?: RuntimeEnv;
    pluginConsent?: ClawPluginInstallConsent;
    skillConsent?: ClawSkillInstallConsent;
    reloadPlugins?: PluginInstallBatchReload;
    commitConfig?: ConfigCommit;
    rebuildPlan?: typeof buildClawUpdatePlan;
    buildAddPlan?: typeof buildClawAddPlan;
    readInstall?: (
      agentId: Parameters<typeof readClawInstallRecord>[0],
      options?: Parameters<typeof readClawInstallRecord>[1],
    ) =>
      | ReturnType<typeof readClawInstallRecord>
      | Promise<ReturnType<typeof readClawInstallRecord>>;
    persistInstall?: (
      plan: Parameters<typeof updateClawInstallRecord>[0],
      options?: Parameters<typeof updateClawInstallRecord>[1],
    ) => PersistedClawInstall | Promise<PersistedClawInstall>;
    applyWorkspace?: typeof applyClawWorkspaceUpdate;
    applyMcp?: typeof applyClawMcpUpdate;
    applyCron?: typeof applyClawCronUpdate;
    applyPackage?: typeof applyClawPackageUpdate;
    cronGateway?: ClawCronGateway;
  },
): Promise<ClawUpdateResult> {
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
  options.assertCurrent?.();
  const inventory = options.stateMode === "worker" ? await readClawInventory(options) : undefined;
  options.assertCurrent?.();
  const fresh = await rebuildPlan({
    agentId: plan.agentId,
    targetManifest: params.targetManifest,
    targetClawMarkdownBody: params.targetClawMarkdownBody,
    targetOpenClawProfile: params.targetOpenClawProfile,
    targetSource: params.targetSource,
    diagnostics: plan.diagnostics,
    config: options.config,
    sourceMcpServers: options.sourceMcpServers,
    ...(inventory ? { inventory, exactAgentId: true } : {}),
    stateOptions:
      options.stateMode === "worker"
        ? { ...options, readOnly: true, packageDeps: options.planPackageDeps }
        : options,
    packagePreflight: options.packagePreflight,
  });
  options.assertCurrent?.();
  if (
    fresh.planIntegrity !== plan.planIntegrity ||
    stableStringify(comparablePlan(fresh)) !== stableStringify(comparablePlan(plan))
  ) {
    throw new ClawUpdateMutationError(
      "update_changed",
      "Claw-owned state changed after update planning; build a new dry-run plan.",
    );
  }

  const actionable = fresh.actions.filter((action) => action.action !== "unchanged");
  if (!fresh.currentClaw || !fresh.targetClaw) {
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
  const installPersistenceOptions = {
    ...options,
    ...(adoptedAgentConfigDigest ? { agentConfigDigest: adoptedAgentConfigDigest } : {}),
  };
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
      packagePreflight: async (pkg, workspace) => {
        const preflight = options.packagePreflight
          ? await options.packagePreflight(pkg, workspace)
          : {
              ok: false,
              code: "package_install_unavailable",
              message: "Package preflight is unavailable.",
            };
        const action = fresh.actions.find(
          (candidate) => candidate.kind === "package" && candidate.id === `${pkg.kind}:${pkg.ref}`,
        );
        return !preflight.ok &&
          action?.action === "change" &&
          ((pkg.kind === "plugin" && preflight.code === "plugin_version_conflict") ||
            (pkg.kind === "skill" &&
              preflight.code === "skill_version_conflict" &&
              preflight.integrity &&
              normalizeClawHubSha256Integrity(preflight.integrity)))
          ? {
              ok: true,
              action: "install" as const,
              ...(preflight.integrity ? { integrity: preflight.integrity } : {}),
              ...(preflight.installId ? { installId: preflight.installId } : {}),
              ...(preflight.warning ? { warning: preflight.warning } : {}),
              ...(preflight.declaredCapabilities
                ? { declaredCapabilities: preflight.declaredCapabilities }
                : {}),
              ...(preflight.capabilityGrants
                ? { capabilityGrants: preflight.capabilityGrants }
                : {}),
              ...(preflight.requirements ? { requirements: preflight.requirements } : {}),
              ...(preflight.detectedFormat ? { detectedFormat: preflight.detectedFormat } : {}),
              ...(preflight.mapped ? { mapped: preflight.mapped } : {}),
              ...(preflight.unavailable ? { unavailable: preflight.unavailable } : {}),
              ...(preflight.adapterIdentity ? { adapterIdentity: preflight.adapterIdentity } : {}),
            }
          : preflight;
      },
    },
  });
  options.assertCurrent?.();
  const unchangedPaths = unchangedPackagePaths(fresh, params.targetManifest);
  if (
    targetAddPlan.blockers.some(
      (blocker) =>
        blocker.code !== "agent_id_collision" &&
        blocker.code !== "workspace_collision" &&
        !(blocker.code === "skill_version_conflict" && unchangedPaths.has(blocker.path)),
    )
  ) {
    throw new ClawUpdateMutationError(
      "update_target_blocked",
      "The target Claw cannot be safely materialized for update.",
    );
  }
  for (const action of fresh.actions.filter(
    (candidate) => candidate.kind === "package" && candidate.action === "unchanged",
  )) {
    const addAction = targetAddPlan.actions.find(
      (candidate) => candidate.kind === "package" && candidate.id === action.id,
    );
    if (!addAction || addAction.details?.expectedState === "absent") {
      throw new ClawUpdateMutationError(
        "update_changed",
        `Package ${JSON.stringify(action.id)} is no longer present; build a new dry-run plan.`,
      );
    }
  }
  const targetPackages = clawTargetPackages(params.targetManifest, params.targetOpenClawProfile);
  for (const action of fresh.actions.filter(
    (candidate) =>
      candidate.kind === "package" &&
      candidate.action !== "unchanged" &&
      candidate.action !== "release" &&
      candidate.action !== "remove",
  )) {
    const target = targetPackages.get(action.id);
    const addAction = targetAddPlan.actions.find(
      (candidate) => candidate.kind === "package" && candidate.id === action.id,
    );
    const details = addAction?.details;
    if (
      !target ||
      action.desiredDigest !==
        digest({
          package: target,
          integrity: details?.integrity,
          installId: details?.installId,
          riskWarning: details?.riskWarning,
          prerequisites: details?.prerequisites,
          declaredCapabilities: details?.declaredCapabilities,
          capabilityGrants: details?.capabilityGrants,
          extension: details?.extension,
        })
    ) {
      throw new ClawUpdateMutationError(
        "update_changed",
        `Resolved package ${JSON.stringify(action.id)} changed after update planning; build a new dry-run plan.`,
      );
    }
  }

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
    options.assertForwardCurrent?.();
    assertReviewedCurrent(phase);
  };
  const preCommitOptions = {
    ...options,
    assertForwardCurrent: () => assertForwardCurrent(),
  };

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
      ...preCommitOptions,
      runtimeBatch,
    });
  };
  const resumedRequirements =
    currentInstall.status === "complete"
      ? []
      : fresh.actions
          .filter(
            (action) =>
              action.kind === "package" &&
              action.action === "unchanged" &&
              targetPackages.get(action.id)?.kind === "plugin",
          )
          .map((action) => {
            const installId = targetAddPlan.actions.find((entry) => entry.id === action.id)?.details
              ?.installId;
            if (typeof installId !== "string" || !installId) {
              throw new ClawUpdateMutationError(
                "update_changed",
                `Plugin requirement ${action.id} lost its installed identity; build a new dry-run plan.`,
              );
            }
            return installId;
          });

  let requirementExecution: ClawPackageUpdateExecution;
  try {
    assertReviewedCurrent();
    requirementExecution =
      requirementActions.length || resumedRequirements.length
        ? await runClawPluginBatch(
            preCommitOptions,
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

  const applyWorkspace = options.applyWorkspace ?? applyClawWorkspaceUpdate;
  let workspaceExecution: ClawWorkspaceUpdateExecution;
  try {
    assertReviewedCurrent();
    workspaceExecution = await applyWorkspace(fresh, targetAddPlan, preCommitOptions);
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
    mcpExecution = await applyMcp(fresh, params.targetManifest, preCommitOptions);
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
      // Adopted ownership records effective settings, including inherited defaults
      // and the canonical workspace, while rollback retains the authored entry.
      return (
        digest(normalizeWorkspaceConfig(resolveMigrationAgentSettings(config, agent), workspace)) ===
        expectedDigest
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
        const { id: _id, ...previousEntry } = preserveOperatorAgentSettings(previousAgent, current);
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
    await packageExecution.commit?.();
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
    previousClaw: fresh.currentClaw,
    targetClaw: fresh.targetClaw,
    appliedActions: actionable,
    installRecord,
  };
}
