import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type {
  ClawActionEffect,
  ClawConfiguredAccess,
  ClawLifecyclePlanResult,
  ClawPluginReview,
  ClawScheduledJobs,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { mapNestedStrings } from "../shared/map-nested-strings.js";
import { digestClawValue } from "./digest.js";
import { projectClawAddScheduledJobs, projectClawConfiguredAccess } from "./gateway-disclosure.js";
import { projectClawManifestDisclosure } from "./gateway-manifest-disclosure.js";
import { digestClawMcpServer } from "./mcp.js";
import { isSafeClawRelativePath } from "./schema-portability.js";
import { mcpServerSchema } from "./schema.js";
import { collectClawSkillWarningReviews } from "./skill-warning-review.js";
import type { ClawAddPlan, ClawAddPlanAction, ClawReadResult } from "./types.js";

type SkillArtifact = NonNullable<Extract<ClawActionEffect, { type: "skill-package" }>["desired"]>;

function skillArtifact(details: Record<string, unknown> | undefined): SkillArtifact {
  const source = details?.source;
  const ref = details?.ref;
  const version = details?.version;
  const rawIntegrity = details?.integrity;
  const integrity =
    typeof rawIntegrity === "string" ? normalizeClawHubSha256Integrity(rawIntegrity) : null;
  if (
    source !== "clawhub" ||
    typeof ref !== "string" ||
    !ref ||
    typeof version !== "string" ||
    !version ||
    !integrity
  ) {
    throw new Error("Claw skill artifact cannot be disclosed.");
  }
  return { source, ref, version, integrity };
}

function assertSkillActionTarget(action: { id: string; target: string }, artifact: SkillArtifact) {
  if (
    action.id !== `skill:${artifact.ref}` ||
    action.target !== `${artifact.source}:${artifact.ref}@${artifact.version}`
  ) {
    throw new Error("Claw skill action does not match its artifact.");
  }
}

function workspaceDestination(id: string): string {
  if (!isSafeClawRelativePath(id)) {
    throw new Error("Claw workspace destination cannot be disclosed.");
  }
  return `workspace/${id.replaceAll("\\", "/")}`;
}

function sourceLabel(action: ClawAddPlanAction, sourceRoot: string): string {
  if (action.sourceKind === "clawMarkdownBody") {
    return "CLAW.md body";
  }
  if (!action.source) {
    throw new Error("Claw workspace source cannot be disclosed.");
  }
  const relative = path.relative(path.resolve(sourceRoot), path.resolve(action.source));
  if (!isSafeClawRelativePath(relative)) {
    throw new Error("Claw workspace source cannot be disclosed.");
  }
  return `package/${relative.split(path.sep).join("/")}`;
}

function mcpDeclaration(details: Record<string, unknown>) {
  const fields = [
    "command",
    "transport",
    "args",
    "env",
    "url",
    "auth",
    "toolFilter",
    "timeout",
    "connectTimeout",
  ] as const;
  const candidate = Object.fromEntries(
    fields.filter((field) => details[field] !== undefined).map((field) => [field, details[field]]),
  );
  const parsed = mcpServerSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error("Claw MCP declaration cannot be disclosed.");
  }
  const server = parsed.data;
  const common = {
    authentication:
      "auth" in server && server.auth === "oauth" ? ("oauth" as const) : ("none" as const),
    ...(server.toolFilter ? { toolFilter: server.toolFilter } : {}),
    ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
    ...(server.connectTimeout !== undefined ? { connectTimeout: server.connectTimeout } : {}),
  };
  if ("command" in server) {
    return {
      declaration: {
        transport: "stdio" as const,
        command: server.command,
        arguments: server.args ?? [],
        environment: Object.entries(server.env ?? {})
          .map(([name, value]) => ({ name, sourceName: value.slice(2, -1) }))
          .toSorted((left, right) => left.name.localeCompare(right.name)),
        ...common,
      },
      digest: digestClawMcpServer(server),
    };
  }
  const safeUrl = new URL(server.url);
  const queryParameterNames = [...new Set(safeUrl.searchParams.keys())].toSorted();
  safeUrl.username = "";
  safeUrl.password = "";
  safeUrl.search = "";
  safeUrl.hash = "";
  return {
    declaration: {
      transport: server.transport,
      url: safeUrl.toString(),
      urlDigest: digestClawValue(server.url),
      ...(queryParameterNames.length ? { queryParameterNames } : {}),
      ...common,
    },
    digest: digestClawMcpServer(server),
  };
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
  const effectBlockers: Array<{ code: string; path: string; message: string }> = [];
  const projectedActions = plan.actions.map((action) => {
    const safe = Object.assign(
      {
        kind: action.kind,
        id: action.id,
        action: action.action,
        blocked: action.blocked,
      },
      action.blocked ? { reason: "Current OpenClaw state blocks this action." } : {},
      !action.blocked &&
        action.kind === "cronJob" &&
        action.id.startsWith("$portable-heartbeat") &&
        action.reason
        ? { reason: action.reason }
        : {},
    );
    if (
      action.kind !== "workspaceFile" &&
      action.kind !== "bootstrap" &&
      action.kind !== "mcpServer" &&
      !(action.kind === "package" && action.id.startsWith("skill:"))
    ) {
      return safe;
    }
    try {
      let effect: ClawActionEffect | undefined;
      if (action.kind === "workspaceFile" || action.kind === "bootstrap") {
        const label = sourceLabel(action, sourceRoot);
        if (!action.digest) {
          throw new Error("Claw workspace file digest cannot be disclosed.");
        }
        effect = {
          type: "workspace-file",
          destination: workspaceDestination(action.id),
          source: label,
          desiredDigest: action.digest,
        };
      } else if (action.kind === "mcpServer") {
        const { declaration, digest } = mcpDeclaration(action.details ?? {});
        effect = { type: "mcp-server", desiredDigest: digest, proposed: declaration };
      } else if (action.kind === "package" && action.id.startsWith("skill:")) {
        if (action.details?.kind !== "skill") {
          throw new Error("Claw skill package kind cannot be disclosed.");
        }
        const desired = skillArtifact(action.details);
        assertSkillActionTarget(action, desired);
        if (
          !action.digest ||
          normalizeClawHubSha256Integrity(action.digest) !== desired.integrity
        ) {
          throw new Error("Claw skill package integrity does not match its preflight.");
        }
        effect = { type: "skill-package", desired };
      }
      if (!effect) {
        throw new Error("Missing Claw action effect.");
      }
      return { ...safe, effect };
    } catch {
      if (!action.blocked) {
        effectBlockers.push({
          code: "effect_disclosure_unavailable",
          path: `$.actions.${action.kind}.${action.id}`,
          message: "This Claw effect cannot be reviewed safely. Refresh or repair the plan.",
        });
      }
      return safe;
    }
  });
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
      actions: projectedActions,
      capabilities: plan.capabilityChanges.map((change) => ({
        kind: change.kind,
        id: change.id,
        action: change.action,
        reason: change.reason,
      })),
      pluginReviews,
      skillReviews: collectClawSkillWarningReviews(plan).map((review) =>
        Object.assign(review, { reviewToken: digestClawValue(review) }),
      ),
      blockers: [
        ...plan.blockers.map((diagnostic) => ({
          code: diagnostic.code,
          path: diagnostic.path,
          message:
            diagnostic.code === "plugin_disabled"
              ? "This plugin is disabled. Enable it in Plugins; reinstall it there first if needed."
              : "Resolve this OpenClaw state conflict before continuing.",
        })),
        ...effectBlockers,
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
        requirements: plan.readiness.requirements.map((requirement) =>
          requirement.kind === "plugin-setup"
            ? { kind: requirement.kind, owner: `${requirement.plugin}/${requirement.provider}` }
            : { kind: requirement.kind, owner: requirement.mcpServer },
        ),
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
