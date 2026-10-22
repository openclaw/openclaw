import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
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
import { mapNestedStrings } from "../shared/map-nested-strings.js";
import { digestClawValue } from "./digest.js";
import { clawActionNeedsEffect, projectClawAddActionEffect } from "./gateway-action-effects.js";
import { projectClawAddScheduledJobs, projectClawConfiguredAccess } from "./gateway-disclosure.js";
import { projectClawManifestDisclosure } from "./gateway-manifest-disclosure.js";
import { collectClawSkillWarningReviews } from "./skill-warning-review.js";
import type {
  ClawAddPlan,
  ClawDiagnostic,
  ClawLocalPrerequisite,
  ClawReadResult,
} from "./types.js";

function safeBlocker(diagnostic: Pick<ClawDiagnostic, "code" | "path">) {
  return {
    code: diagnostic.code,
    path: diagnostic.path,
    message:
      diagnostic.code === "plugin_disabled"
        ? "This plugin is disabled. Enable it in Plugins; reinstall it there first if needed."
        : "Resolve this OpenClaw state conflict before continuing.",
  };
}

function safeAction(action: {
  kind: string;
  id: string;
  action: string;
  blocked: boolean;
  reason?: string;
}) {
  return {
    kind: action.kind,
    id: action.id,
    action: action.action,
    blocked: action.blocked,
    ...(action.blocked ? { reason: "Current OpenClaw state blocks this action." } : {}),
    ...(!action.blocked &&
    action.kind === "cronJob" &&
    action.id.startsWith("$portable-heartbeat") &&
    action.reason
      ? { reason: action.reason }
      : {}),
  };
}

function projectActionsWithEffects<
  T extends { kind: string; id: string; action: string; blocked: boolean },
>(actions: readonly T[], projectEffect: (action: T) => ClawActionEffect | undefined) {
  const blockers: Array<{ code: string; path: string; message: string }> = [];
  const projected = actions.map((action) => {
    const safe = safeAction(action);
    if (!clawActionNeedsEffect(action)) {
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

function projectClawSkillWarningReviews(plan: ClawAddPlan): ClawSkillReview[] {
  return collectClawSkillWarningReviews(plan).map((review) =>
    Object.assign(review, { reviewToken: digestClawValue(review) }),
  );
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
  const planIntegrity = `sha256:${sha256Hex(stableStringify({ canonicalPlanIntegrity, plan }))}`;
  return { schemaVersion: "openclaw.clawsGatewayPlan.v1", planIntegrity, ...plan };
}

function canonicalizeClawSourcePlan(value: unknown, sourceRoot: string): unknown {
  const root = path.resolve(sourceRoot);
  return mapNestedStrings(value, (current) => {
    if (path.isAbsolute(current)) {
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
    return current;
  });
}

function sourceStablePlanIntegrity(plan: { planIntegrity: string }, sourceRoot: string): string {
  const { planIntegrity: _planIntegrity, ...content } = plan;
  return `sha256:${sha256Hex(stableStringify(canonicalizeClawSourcePlan(content, sourceRoot)))}`;
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
  source?: Extract<ClawReadResult, { ok: true }>,
): ClawLifecyclePlanResult {
  const effects = projectActionsWithEffects(plan.actions, (action) =>
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
  const agentIdCollision = plan.blockers.some((blocker) => blocker.code === "agent_id_collision");
  const configuredAccess = agentIdCollision
    ? undefined
    : projectClawConfiguredAccess({
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
        workspace: plan.agent.workspace,
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
        ...(agentIdCollision
          ? [
              {
                code: "configured_access_unavailable",
                path: "$.agent.id",
                message: "Configured access cannot be reviewed while this agent ID is in use.",
              },
            ]
          : []),
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
      ...(source ? { manifestDisclosure: projectClawManifestDisclosure(source, plan.claw) } : {}),
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
