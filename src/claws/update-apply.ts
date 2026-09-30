import { createHash } from "node:crypto";
import { coerceErrorMessage, stableStringify } from "@openclaw/normalization-core";
import { transformConfigFileWithRetry } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import type { RuntimeEnv } from "../runtime.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { OpenClawStateLeaseError } from "../state/openclaw-state-lease.js";
import { withClawAgentMutationLease } from "./add-apply-lease.js";
import { preserveAdoptedAgentDefault } from "./adopted-agent-update.js";
import { resolveCanonicalClawAgent, resolveClawAgentRosterKey } from "./agent-adoption-apply.js";
import { clawTargetPackages } from "./application-provenance.js";
import {
  applyClawCronUpdate,
  ClawCronUpdateError,
  type ClawCronUpdateExecution,
} from "./cron-update.js";
import type { ClawCronGateway } from "./cron.js";
import { buildClawAddPlan, type ClawAddPlanContext } from "./lifecycle.js";
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
import { runClawPluginBatch, type ClawPluginRuntimeOptions } from "./plugin-runtime.js";
import {
  readClawInstallRecord,
  updateClawInstallRecord,
  updateClawInstallRecordStatus,
  type PersistedClawInstall,
} from "./provenance.js";
import {
  CLAW_OUTPUT_STABILITY,
  type ClawManifest,
  type ClawOpenClawProfile,
  type ClawSourceIdentity,
} from "./types.js";
import { replaceClawUpdateAgent } from "./update-agent-config.js";
import { buildClawUpdatePlan, type ClawUpdateAction, type ClawUpdatePlan } from "./update-plan.js";
import { collectClawRollbackFailures } from "./update-rollback.js";
import {
  applyClawWorkspaceUpdate,
  ClawWorkspaceUpdateError,
  type ClawWorkspaceUpdateExecution,
} from "./workspace-update.js";

export const CLAW_UPDATE_RESULT_SCHEMA_VERSION = "openclaw.clawUpdateResult.v1" as const;

type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;

type ClawUpdateApplyOptions = OpenClawStateDatabaseOptions & {
  config: OpenClawConfig;
  sourceMcpServers: Record<string, Record<string, unknown>>;
  consentPlanIntegrity: string | undefined;
  packagePreflight?: ClawAddPlanContext["packagePreflight"];
  runtime?: RuntimeEnv;
  reloadPlugins?: PluginInstallBatchReload;
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
  signal?: AbortSignal;
  /** Internal live authority installed by the agent lifecycle mutation lease. */
  assertAgentMutationLeaseOwned?: () => void;
};

function assertAgentMutationLeaseOwned(options: ClawUpdateApplyOptions): void {
  options.assertAgentMutationLeaseOwned?.();
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

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
  options: ClawUpdateApplyOptions,
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

  try {
    return await withClawAgentMutationLease(plan.agentId, options, async (lease) =>
      applyClawUpdatePlanOwned(plan, params, {
        ...options,
        signal: lease.signal,
        assertAgentMutationLeaseOwned: lease.assertOwned,
      }),
    );
  } catch (error) {
    if (error instanceof OpenClawStateLeaseError) {
      throw new ClawUpdateMutationError("update_lease_failed", error.message, { cause: error });
    }
    throw error;
  }
}

async function applyClawUpdatePlanOwned(
  plan: ClawUpdatePlan,
  params: {
    targetManifest: ClawManifest;
    targetClawMarkdownBody?: Buffer;
    targetOpenClawProfile?: ClawOpenClawProfile;
    targetSource: ClawSourceIdentity;
  },
  options: ClawUpdateApplyOptions,
): Promise<ClawUpdateResult> {
  assertAgentMutationLeaseOwned(options);

  const rebuildPlan = options.rebuildPlan ?? buildClawUpdatePlan;
  const fresh = await rebuildPlan({
    agentId: plan.agentId,
    targetManifest: params.targetManifest,
    targetClawMarkdownBody: params.targetClawMarkdownBody,
    targetOpenClawProfile: params.targetOpenClawProfile,
    targetSource: params.targetSource,
    config: options.config,
    sourceMcpServers: options.sourceMcpServers,
    stateOptions: options,
    packagePreflight: options.packagePreflight,
  });
  assertAgentMutationLeaseOwned(options);
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
  const partialMutation = (
    message: string,
    errorOptions?: ErrorOptions,
  ): ClawUpdateMutationError => {
    assertAgentMutationLeaseOwned(options);
    try {
      updateClawInstallRecordStatus(fresh.agentId, "partial", options);
    } catch {
      // Preserve the owner failure; doctor can still reconcile subordinate pending records.
    }
    return new ClawUpdateMutationError("update_partial", message, errorOptions);
  };
  const guardedRollback = (rollback: () => void | Promise<void>) => async () => {
    assertAgentMutationLeaseOwned(options);
    await rollback();
    assertAgentMutationLeaseOwned(options);
  };
  const rawTargetAddPlan = await buildAddPlan({
    manifest: params.targetManifest,
    clawMarkdownBody: params.targetClawMarkdownBody,
    includePackageBootstrap: false,
    openClawProfile: params.targetOpenClawProfile,
    source: params.targetSource,
    context: {
      agentId: fresh.agentId,
      workspace: currentInstall.workspace,
      packagePreflight: async (pkg, workspace) => {
        assertAgentMutationLeaseOwned(options);
        const preflight = options.packagePreflight
          ? await options.packagePreflight(pkg, workspace)
          : {
              ok: false,
              code: "package_install_unavailable",
              message: "Package preflight is unavailable.",
            };
        assertAgentMutationLeaseOwned(options);
        const action = fresh.actions.find(
          (candidate) => candidate.kind === "package" && candidate.id === `${pkg.kind}:${pkg.ref}`,
        );
        return !preflight.ok &&
          pkg.kind === "plugin" &&
          preflight.code === "plugin_version_conflict" &&
          action?.action === "change"
          ? {
              ok: true,
              action: "install" as const,
              ...(preflight.integrity ? { integrity: preflight.integrity } : {}),
              ...(preflight.installId ? { installId: preflight.installId } : {}),
              ...(preflight.warning ? { warning: preflight.warning } : {}),
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
  assertAgentMutationLeaseOwned(options);
  const unchangedPaths = unchangedPackagePaths(fresh, params.targetManifest);
  const liveAgent = resolveCanonicalClawAgent(options.config, fresh.agentId);
  const targetAddPlan = preserveAdoptedAgentDefault({
    plan: rawTargetAddPlan,
    install: currentInstall,
    liveAgent,
  });
  if (!targetAddPlan) {
    throw new ClawUpdateMutationError(
      "agent_changed",
      "The adopted agent changed before update materialization.",
    );
  }
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
  const agentAction = fresh.actions.find((action) => action.kind === "agent");
  if (agentAction && agentAction.desiredDigest !== digest(targetAddPlan.agent.config)) {
    throw new ClawUpdateMutationError(
      "update_changed",
      "The materialized agent configuration changed after update planning.",
    );
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
          extension: details?.extension,
        })
    ) {
      throw new ClawUpdateMutationError(
        "update_changed",
        `Resolved package ${JSON.stringify(action.id)} changed after update planning; build a new dry-run plan.`,
      );
    }
  }

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
    assertAgentMutationLeaseOwned(options);
    if (actions.length === 0) {
      return { appliedIds: [], rollback: async () => undefined };
    }
    const execution = await applyPackage({ ...fresh, actions }, targetAddPlan, {
      ...options,
      runtimeBatch,
    });
    assertAgentMutationLeaseOwned(options);
    return execution;
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
    assertAgentMutationLeaseOwned(options);
    requirementExecution =
      requirementActions.length || resumedRequirements.length
        ? await runClawPluginBatch(
            options,
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
    assertAgentMutationLeaseOwned(options);
  } catch (error) {
    assertAgentMutationLeaseOwned(options);
    if (error instanceof ClawPackageUpdateError && error.partial) {
      throw partialMutation(error.message, { cause: error });
    }
    throw new ClawUpdateMutationError("package_update_failed", coerceErrorMessage(error), {
      cause: error,
    });
  }
  const retainedRequirementMutation = requirementExecution.appliedIds.length > 0;
  const throwIfUpdatePartial = (error: unknown, rollbackFailures: string[] = []): void => {
    if (rollbackFailures.length > 0) {
      throw partialMutation(`${coerceErrorMessage(error)}; ${rollbackFailures.join("; ")}`);
    }
    if (retainedRequirementMutation) {
      throw partialMutation(
        `${coerceErrorMessage(error)}; successfully realized shared requirements were retained`,
      );
    }
  };

  const applyWorkspace = options.applyWorkspace ?? applyClawWorkspaceUpdate;
  let workspaceExecution: ClawWorkspaceUpdateExecution;
  try {
    assertAgentMutationLeaseOwned(options);
    workspaceExecution = await applyWorkspace(fresh, targetAddPlan, options);
    assertAgentMutationLeaseOwned(options);
  } catch (error) {
    assertAgentMutationLeaseOwned(options);
    if (error instanceof ClawWorkspaceUpdateError && error.partial) {
      throw partialMutation(error.message);
    }
    throwIfUpdatePartial(error);
    throw new ClawUpdateMutationError("workspace_update_failed", coerceErrorMessage(error));
  }

  const applyMcp = options.applyMcp ?? applyClawMcpUpdate;
  let mcpExecution: ClawMcpUpdateExecution;
  try {
    assertAgentMutationLeaseOwned(options);
    mcpExecution = await applyMcp(fresh, params.targetManifest, options);
    assertAgentMutationLeaseOwned(options);
  } catch (error) {
    assertAgentMutationLeaseOwned(options);
    const partial = error instanceof ClawMcpUpdateError && error.partial;
    try {
      await guardedRollback(() => workspaceExecution.rollback())();
    } catch (rollbackError) {
      throw partialMutation(
        `${coerceErrorMessage(error)}; workspace rollback failed: ${coerceErrorMessage(rollbackError)}`,
      );
    }
    if (partial) {
      throw partialMutation(`${error.message}; MCP config write outcome is uncertain`);
    }
    throwIfUpdatePartial(error);
    throw new ClawUpdateMutationError("mcp_update_failed", coerceErrorMessage(error));
  }

  let packageExecution: ClawPackageUpdateExecution;
  try {
    assertAgentMutationLeaseOwned(options);
    packageExecution = await applyPackageActions(remainingPackageActions);
    assertAgentMutationLeaseOwned(options);
  } catch (error) {
    assertAgentMutationLeaseOwned(options);
    // Keep method lookup and receiver binding inside each step.
    const rollbackFailures = await collectClawRollbackFailures([
      ["MCP rollback failed", guardedRollback(() => mcpExecution.rollback())],
      ["workspace rollback failed", guardedRollback(() => workspaceExecution.rollback())],
    ]);
    if (error instanceof ClawPackageUpdateError && error.partial) {
      rollbackFailures.unshift("package artifact rollback is unavailable");
    }
    throwIfUpdatePartial(error, rollbackFailures);
    throw new ClawUpdateMutationError("package_update_failed", coerceErrorMessage(error));
  }

  const rawCommit: ConfigCommit =
    options.commitConfig ??
    (async (transform) => {
      await transformConfigFileWithRetry({
        afterWrite: { mode: "auto" },
        transform: (config) => ({ nextConfig: transform(config) }),
      });
    });
  const commit: ConfigCommit = async (transform) => {
    assertAgentMutationLeaseOwned(options);
    await rawCommit((config) => {
      assertAgentMutationLeaseOwned(options);
      return transform(config);
    });
    assertAgentMutationLeaseOwned(options);
  };
  let previousAgent: AgentConfig | undefined;
  let previousAgentKey: string | undefined;
  let agentChanged = false;
  const rollbackAgent = async (): Promise<void> => {
    if (!agentChanged) {
      return;
    }
    await commit((config) => {
      const current = resolveCanonicalClawAgent(config, fresh.agentId);
      const targetDigest = digest(targetAddPlan.agent.config);
      const liveDigest = current ? digest(current) : undefined;
      if (liveDigest !== targetDigest) {
        throw new Error("The agent changed before rollback.");
      }
      return replaceClawUpdateAgent({
        config,
        agentId: fresh.agentId,
        replacement: previousAgent
          ? { ...previousAgent, id: previousAgentKey ?? previousAgent.id }
          : undefined,
      });
    });
    agentChanged = false;
  };
  if (agentAction?.action === "change") {
    try {
      await commit((config) => {
        const current = resolveCanonicalClawAgent(config, fresh.agentId);
        previousAgent = current;
        previousAgentKey = resolveClawAgentRosterKey(config, fresh.agentId);
        if (agentAction.currentDigest !== undefined) {
          if (!current) {
            throw new ClawUpdateMutationError(
              "agent_changed",
              "The owned agent entry disappeared during update.",
            );
          }
          const liveDigest = digest(current);
          if (liveDigest !== agentAction.currentDigest) {
            throw new ClawUpdateMutationError(
              "agent_changed",
              "The owned agent entry changed during update.",
            );
          }
        }
        agentChanged = true;
        return replaceClawUpdateAgent({
          config,
          agentId: fresh.agentId,
          replacement: targetAddPlan.agent.config,
        });
      });
    } catch (error) {
      const rollbackFailures = await collectClawRollbackFailures([
        ["agent rollback failed", guardedRollback(rollbackAgent)],
        ["package rollback incomplete", guardedRollback(() => packageExecution.rollback())],
        ["MCP rollback failed", guardedRollback(() => mcpExecution.rollback())],
        ["workspace rollback failed", guardedRollback(() => workspaceExecution.rollback())],
      ]);
      throwIfUpdatePartial(error, rollbackFailures);
      if (error instanceof ClawUpdateMutationError) {
        throw error;
      }
      throw new ClawUpdateMutationError("agent_update_failed", coerceErrorMessage(error));
    }
  }

  const persistInstall = options.persistInstall ?? updateClawInstallRecord;
  const applyCron = options.applyCron ?? applyClawCronUpdate;
  let cronExecution: ClawCronUpdateExecution;
  try {
    assertAgentMutationLeaseOwned(options);
    cronExecution = await applyCron(fresh, params.targetManifest, options);
    assertAgentMutationLeaseOwned(options);
  } catch (error) {
    assertAgentMutationLeaseOwned(options);
    if (error instanceof ClawCronUpdateError && error.partial) {
      try {
        persistInstall(targetAddPlan, {
          ...options,
          expectedClaw: fresh.currentClaw,
          status: "partial",
        });
      } catch (persistError) {
        throw partialMutation(
          `${error.message}; cron gateway mutation outcome is uncertain; provenance update failed: ${coerceErrorMessage(persistError)}`,
        );
      }
      throw partialMutation(`${error.message}; cron gateway mutation outcome is uncertain`);
    }
    const rollbackFailures = await collectClawRollbackFailures([
      ["agent rollback failed", guardedRollback(rollbackAgent)],
      ["package rollback incomplete", guardedRollback(() => packageExecution.rollback())],
      ["MCP rollback failed", guardedRollback(() => mcpExecution.rollback())],
      ["workspace rollback failed", guardedRollback(() => workspaceExecution.rollback())],
    ]);
    throwIfUpdatePartial(error, rollbackFailures);
    throw new ClawUpdateMutationError("cron_update_failed", coerceErrorMessage(error));
  }

  let installRecord: PersistedClawInstall;
  try {
    assertAgentMutationLeaseOwned(options);
    installRecord = persistInstall(targetAddPlan, {
      ...options,
      expectedClaw: fresh.currentClaw,
    });
    assertAgentMutationLeaseOwned(options);
  } catch (error) {
    assertAgentMutationLeaseOwned(options);
    const rollbackFailures = await collectClawRollbackFailures([
      ["agent rollback failed", guardedRollback(rollbackAgent)],
      ["package rollback incomplete", guardedRollback(() => packageExecution.rollback())],
      ["cron rollback failed", guardedRollback(() => cronExecution.rollback())],
      ["MCP rollback failed", guardedRollback(() => mcpExecution.rollback())],
      ["workspace rollback failed", guardedRollback(() => workspaceExecution.rollback())],
    ]);
    throwIfUpdatePartial(error, rollbackFailures);
    throw new ClawUpdateMutationError("provenance_update_failed", coerceErrorMessage(error));
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
