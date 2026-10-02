import { createHash } from "node:crypto";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import type {
  ClawActionEffect,
  ClawConfiguredAccess,
  ClawLifecyclePlanResult,
  ClawPluginReview,
  ClawSkillReview,
  ClawScheduledJobs,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { digestClawValue } from "./digest.js";
import {
  clawActionNeedsEffect,
  projectClawAddActionEffect,
  projectClawRemoveActionEffect,
  projectClawUpdateActionEffect,
} from "./gateway-action-effects.js";
import {
  projectClawAddScheduledJobs,
  projectClawConfiguredAccess,
  projectClawRemoveScheduledJobs,
  projectClawUpdateScheduledJobs,
} from "./gateway-disclosure.js";
import type { ClawRemovePlan } from "./lifecycle-remove-contract.js";
import type { PersistedClawPackageRef } from "./provenance.js";
import type {
  ClawAddPlan,
  ClawAddPlanAction,
  ClawCronJob,
  ClawDiagnostic,
  ClawLocalPrerequisite,
} from "./types.js";
import type { ClawUpdateAction, ClawUpdatePlan } from "./update-plan-types.js";

function safeBlocker(diagnostic: Pick<ClawDiagnostic, "code" | "path">) {
  return {
    code: diagnostic.code,
    path: diagnostic.path,
    message:
      diagnostic.code === "plugin_disabled"
        ? "This plugin is installed but disabled. Enable it in Plugins before continuing."
        : "Resolve this OpenClaw state conflict before continuing.",
  };
}

function safeAction(action: { kind: string; id: string; action: string; blocked: boolean }) {
  return {
    kind: action.kind,
    id: action.id,
    action: action.action,
    blocked: action.blocked,
    ...(action.blocked ? { reason: "Current OpenClaw state blocks this action." } : {}),
  };
}

function projectActionsWithEffects<
  T extends { kind: string; id: string; action: string; blocked: boolean },
>(
  operation: "add" | "update" | "remove",
  actions: readonly T[],
  projectEffect: (action: T) => ClawActionEffect | undefined,
) {
  const blockers: Array<{ code: string; path: string; message: string }> = [];
  const projected = actions.map((action) => {
    const safe = safeAction(action);
    if (!clawActionNeedsEffect(operation, action)) {
      return safe;
    }
    try {
      const effect = projectEffect(action);
      if (!effect) {
        throw new Error("Missing Claw action effect.");
      }
      return { ...safe, effect };
    } catch {
      if (!action.blocked) {
        blockers.push({
          code: "effect_disclosure_unavailable",
          path: `$.actions.${action.kind}.${action.id}`,
          message: "This Claw effect cannot be reviewed safely. Refresh or repair the plan.",
        });
      }
      return safe;
    }
  });
  return { actions: projected, blockers };
}

function safeCapability(change: { kind: string; id: string; action: string; reason: string }) {
  return { kind: change.kind, id: change.id, action: change.action, reason: change.reason };
}

function requestedPolicyBlockers(
  desiredAgent: AgentConfig,
  configuredAccess: ClawConfiguredAccess | undefined,
) {
  const blockers: Array<{ code: string; path: string; message: string }> = [];
  if (
    desiredAgent.memory?.search &&
    desiredAgent.memory.search.enabled !== false &&
    configuredAccess?.desired?.memorySearch.state === "unresolved"
  ) {
    blockers.push({
      code: "claw_memory_policy_unresolved",
      path: "$.agent.memory.search",
      message:
        "The Claw-requested memory access cannot be reviewed. Restore its provider and refresh the plan.",
    });
  }
  return blockers;
}

export function projectClawSkillWarningReviews(plan: ClawAddPlan): ClawSkillReview[] {
  return plan.actions.flatMap((action) => {
    const details = action.details;
    if (
      action.kind !== "package" ||
      action.blocked ||
      details?.kind !== "skill" ||
      details.ownerAction !== "install" ||
      typeof details.riskWarning !== "string" ||
      !details.riskWarning
    ) {
      return [];
    }
    if (
      typeof details.ref !== "string" ||
      typeof details.version !== "string" ||
      typeof details.integrity !== "string"
    ) {
      throw new Error("The Claw skill trust review is incomplete.");
    }
    const review = {
      actionId: action.id,
      ref: details.ref,
      version: details.version,
      integrity: details.integrity,
      riskWarning: details.riskWarning,
    };
    return [{ ...review, reviewToken: digestClawValue(review) }];
  });
}

function projectReadinessRequirement(requirement: ClawLocalPrerequisite) {
  return requirement.kind === "plugin-setup"
    ? { kind: requirement.kind, owner: `${requirement.plugin}/${requirement.provider}` }
    : { kind: requirement.kind, owner: requirement.mcpServer };
}

function sealClawLifecyclePlan(
  plan: Omit<ClawLifecyclePlanResult, "schemaVersion" | "planIntegrity">,
  canonicalPlanIntegrity: string,
): ClawLifecyclePlanResult {
  const planIntegrity = `sha256:${createHash("sha256")
    .update(stableStringify({ canonicalPlanIntegrity, plan }))
    .digest("hex")}`;
  return { schemaVersion: "openclaw.clawsGatewayPlan.v1", planIntegrity, ...plan };
}

export function canonicalizeClawSourcePlan(value: unknown, sourceRoot: string): unknown {
  const root = path.resolve(sourceRoot);
  const visit = (current: unknown): unknown => {
    if (typeof current === "string" && path.isAbsolute(current)) {
      const relative = path.relative(root, path.resolve(current));
      if (relative === "") {
        return "$CLAW_SOURCE";
      }
      if (
        !relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative)
      ) {
        return `$CLAW_SOURCE/${relative.split(path.sep).join("/")}`;
      }
      return current;
    }
    if (Array.isArray(current)) {
      return current.map(visit);
    }
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current).map(([key, entry]) => [key, visit(entry)]));
    }
    return current;
  };
  return visit(value);
}

function sourceStablePlanIntegrity(plan: { planIntegrity: string }, sourceRoot: string): string {
  const { planIntegrity: _planIntegrity, ...content } = plan;
  return `sha256:${createHash("sha256")
    .update(stableStringify(canonicalizeClawSourcePlan(content, sourceRoot)))
    .digest("hex")}`;
}

export function plansMatchAcrossSourceRoots(params: {
  preview: { planIntegrity: string };
  previewRoot: string;
  persisted: { planIntegrity: string };
  persistedRoot: string;
}): boolean {
  const { planIntegrity: _previewIntegrity, ...preview } = params.preview;
  const { planIntegrity: _persistedIntegrity, ...persisted } = params.persisted;
  return (
    stableStringify(canonicalizeClawSourcePlan(preview, params.previewRoot)) ===
    stableStringify(canonicalizeClawSourcePlan(persisted, params.persistedRoot))
  );
}

export function projectClawAddPlan(
  plan: ClawAddPlan,
  sourceRoot: string,
  pluginReviews: ClawPluginReview[],
  config: OpenClawConfig,
): ClawLifecyclePlanResult {
  const effects = projectActionsWithEffects("add", plan.actions, (action) =>
    projectClawAddActionEffect(action, sourceRoot),
  );
  let scheduledJobs: ClawScheduledJobs | undefined;
  try {
    scheduledJobs = projectClawAddScheduledJobs(plan);
  } catch {
    scheduledJobs = undefined;
  }
  const expectedPluginActions = plan.actions
    .filter(
      (action) => action.kind === "package" && action.details?.kind === "plugin" && !action.blocked,
    )
    .map((action) => action.id)
    .toSorted();
  const reviewedPluginActions = pluginReviews.map((review) => review.actionId).toSorted();
  if (stableStringify(expectedPluginActions) !== stableStringify(reviewedPluginActions)) {
    throw new Error("The Claw plugin capability review is incomplete.");
  }
  const configuredAccess = projectClawConfiguredAccess({
    config,
    agentId: plan.agent.finalId,
    desiredAgent: plan.agent.config,
    operation: "add",
  });
  return sealClawLifecyclePlan(
    {
      operation: "add",
      target: {
        agentId: plan.agent.finalId,
        name: plan.claw.name,
        targetVersion: plan.claw.version,
      },
      actions: effects.actions,
      capabilities: plan.capabilityChanges.map(safeCapability),
      pluginReviews,
      skillReviews: projectClawSkillWarningReviews(plan),
      blockers: [
        ...plan.blockers.map(safeBlocker),
        ...effects.blockers,
        ...requestedPolicyBlockers(plan.agent.config, configuredAccess),
        ...(!scheduledJobs
          ? [
              {
                code: "schedule_disclosure_unavailable",
                path: "$.cronJobs",
                message: "Scheduled work cannot be reviewed safely. Refresh or repair the plan.",
              },
            ]
          : []),
      ],
      riskAcknowledgementRequired: false,
      configuredAccess,
      ...(scheduledJobs ? { scheduledJobs } : {}),
      readiness: {
        ready: plan.readiness.ready,
        requirements: plan.readiness.requirements.map(projectReadinessRequirement),
      },
    },
    sourceStablePlanIntegrity(plan, sourceRoot),
  );
}

export function projectClawUpdatePlan(
  plan: ClawUpdatePlan,
  sourceRoot: string,
  review: {
    config: OpenClawConfig;
    desiredAgent?: AgentConfig;
    currentJobs: readonly ClawCronJob[];
    targetJobs: readonly ClawCronJob[];
    pluginReviews?: ClawPluginReview[];
    targetActions?: readonly ClawAddPlanAction[];
    currentPackages?: readonly PersistedClawPackageRef[];
    skillReviews?: ClawSkillReview[];
  },
): ClawLifecyclePlanResult {
  const effects = projectActionsWithEffects("update", plan.actions, (action: ClawUpdateAction) =>
    projectClawUpdateActionEffect(
      action,
      review.targetActions ?? [],
      review.currentPackages ?? [],
      sourceRoot,
    ),
  );
  const expectedPluginActions = plan.actions
    .filter(
      (action) =>
        action.kind === "package" &&
        action.id.startsWith("plugin:") &&
        (action.action === "add" || action.action === "change") &&
        !action.blocked,
    )
    .map((action) => action.id)
    .toSorted();
  const pluginReviews = review.pluginReviews ?? [];
  const reviewedPluginActions = pluginReviews.map((entry) => entry.actionId).toSorted();
  const pluginConsentUnavailable =
    stableStringify(expectedPluginActions) !== stableStringify(reviewedPluginActions);
  let configuredAccess: ClawConfiguredAccess | undefined;
  let scheduledJobs: ClawScheduledJobs | undefined;
  if (review.desiredAgent) {
    try {
      configuredAccess = projectClawConfiguredAccess({
        config: review.config,
        agentId: plan.agentId,
        desiredAgent: review.desiredAgent,
        operation: "update",
      });
      scheduledJobs = projectClawUpdateScheduledJobs(plan, review.currentJobs, review.targetJobs);
    } catch {
      configuredAccess = undefined;
      scheduledJobs = undefined;
    }
  }
  return sealClawLifecyclePlan(
    {
      operation: "update",
      target: {
        agentId: plan.agentId,
        ...(plan.targetClaw?.name || plan.currentClaw?.name
          ? { name: plan.targetClaw?.name ?? plan.currentClaw?.name }
          : {}),
        ...(plan.currentClaw?.version ? { currentVersion: plan.currentClaw.version } : {}),
        ...(plan.targetClaw?.version ? { targetVersion: plan.targetClaw.version } : {}),
      },
      actions: effects.actions,
      capabilities: plan.capabilityChanges.map(safeCapability),
      pluginReviews,
      skillReviews: review.skillReviews ?? [],
      blockers: [
        ...plan.blockers.map(safeBlocker),
        ...effects.blockers,
        ...(review.desiredAgent
          ? requestedPolicyBlockers(review.desiredAgent, configuredAccess)
          : []),
        ...(pluginConsentUnavailable
          ? [
              {
                code: "plugin_consent_unavailable",
                path: "$.packages",
                message: "Plugin capability review is required before this update.",
              },
            ]
          : []),
        ...(!configuredAccess || !scheduledJobs
          ? [
              {
                code: "configured_access_unavailable",
                path: "$.agent",
                message: "Configured access or scheduled work cannot be reviewed for this update.",
              },
            ]
          : []),
      ],
      riskAcknowledgementRequired: false,
      ...(configuredAccess ? { configuredAccess } : {}),
      ...(scheduledJobs ? { scheduledJobs } : {}),
      readiness: {
        ready: plan.readiness.ready,
        requirements: plan.readiness.requirements.map(projectReadinessRequirement),
      },
    },
    sourceStablePlanIntegrity(plan, sourceRoot),
  );
}

export function projectClawRemovePlan(
  plan: ClawRemovePlan,
  installed?: { name: string; version: string },
): ClawLifecyclePlanResult {
  const effects = projectActionsWithEffects("remove", plan.actions, projectClawRemoveActionEffect);
  let scheduledJobs: ClawScheduledJobs | undefined;
  try {
    scheduledJobs = projectClawRemoveScheduledJobs(plan);
  } catch {
    scheduledJobs = undefined;
  }
  return sealClawLifecyclePlan(
    {
      operation: "remove",
      target: {
        ...(plan.agentId ? { agentId: plan.agentId } : {}),
        ...(installed ? { name: installed.name, currentVersion: installed.version } : {}),
      },
      actions: effects.actions,
      capabilities: [],
      pluginReviews: [],
      skillReviews: [],
      blockers: [
        ...plan.blockers.map((blocker) => ({
          code: blocker.code,
          path: "$",
          message: "Resolve this OpenClaw state conflict before continuing.",
        })),
        ...effects.blockers,
        ...(!scheduledJobs
          ? [
              {
                code: "schedule_disclosure_unavailable",
                path: "$.cronJobs",
                message: "Scheduled work cannot be reviewed safely. Refresh or repair the plan.",
              },
            ]
          : []),
      ],
      riskAcknowledgementRequired: false,
      ...(scheduledJobs ? { scheduledJobs } : {}),
    },
    plan.planIntegrity,
  );
}

export function bindClawLifecycleTrust(
  plan: ClawLifecyclePlanResult,
  trust: { trustWarning?: string; riskAcknowledgementRequired: boolean },
): ClawLifecyclePlanResult {
  const { schemaVersion: _schemaVersion, planIntegrity, ...projection } = plan;
  return sealClawLifecyclePlan(
    {
      ...projection,
      ...(trust.trustWarning ? { trustWarning: trust.trustWarning } : {}),
      riskAcknowledgementRequired: trust.riskAcknowledgementRequired,
    },
    planIntegrity,
  );
}
