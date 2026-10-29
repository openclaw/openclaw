import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type {
  TemplateActionEffect,
  TemplateConfiguredAccess,
  TemplateLifecyclePlanResult,
  TemplatePluginReview,
  TemplateScheduledJobs,
} from "../../packages/gateway-protocol/src/schema/templates.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { mapNestedStrings } from "../shared/map-nested-strings.js";
import { digestTemplateValue } from "./digest.js";
import {
  projectTemplateAddScheduledJobs,
  projectTemplateConfiguredAccess,
} from "./gateway-disclosure.js";
import { projectTemplateManifestDisclosure } from "./gateway-manifest-disclosure.js";
import { digestTemplateMcpServer } from "./mcp.js";
import { isSafeTemplateRelativePath } from "./schema-portability.js";
import { mcpServerSchema } from "./schema.js";
import { collectTemplateSkillWarningReviews } from "./skill-warning-review.js";
import type { TemplateAddPlan, TemplateAddPlanAction, TemplateReadResult } from "./types.js";

type SkillArtifact = NonNullable<
  Extract<TemplateActionEffect, { type: "skill-package" }>["desired"]
>;

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
    throw new Error("Template skill artifact cannot be disclosed.");
  }
  return { source, ref, version, integrity };
}

function assertSkillActionTarget(action: { id: string; target: string }, artifact: SkillArtifact) {
  if (
    action.id !== `skill:${artifact.ref}` ||
    action.target !== `${artifact.source}:${artifact.ref}@${artifact.version}`
  ) {
    throw new Error("Template skill action does not match its artifact.");
  }
}

function workspaceDestination(id: string): string {
  if (!isSafeTemplateRelativePath(id)) {
    throw new Error("Template workspace destination cannot be disclosed.");
  }
  return `workspace/${id.replaceAll("\\", "/")}`;
}

function sourceLabel(action: TemplateAddPlanAction, sourceRoot: string): string {
  if (action.sourceKind === "templateMarkdownBody") {
    return "CLAW.md body";
  }
  if (!action.source) {
    throw new Error("Template workspace source cannot be disclosed.");
  }
  const relative = path.relative(path.resolve(sourceRoot), path.resolve(action.source));
  if (!isSafeTemplateRelativePath(relative)) {
    throw new Error("Template workspace source cannot be disclosed.");
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
    throw new Error("Template MCP declaration cannot be disclosed.");
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
      digest: digestTemplateMcpServer(server),
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
      urlDigest: digestTemplateValue(server.url),
      ...(queryParameterNames.length ? { queryParameterNames } : {}),
      ...common,
    },
    digest: digestTemplateMcpServer(server),
  };
}

function requestedPolicyBlockers(
  desiredAgent: AgentConfig,
  configuredAccess: TemplateConfiguredAccess | undefined,
) {
  const blockers: Array<{ code: string; path: string; message: string }> = [];
  if (
    desiredAgent.memory?.search &&
    desiredAgent.memory.search.enabled !== false &&
    configuredAccess?.desired?.memorySearch.state === "unresolved"
  ) {
    blockers.push({
      code: "template_memory_policy_unresolved",
      path: "$.agent.memory.search",
      message:
        "The Template-requested memory access cannot be reviewed. Restore its provider and refresh the plan.",
    });
  }
  return blockers;
}

function sealTemplateLifecyclePlan(
  plan: Omit<TemplateLifecyclePlanResult, "schemaVersion" | "planIntegrity">,
  canonicalPlanIntegrity: string,
): TemplateLifecyclePlanResult {
  const planIntegrity = `sha256:${sha256Hex(stableStringify({ canonicalPlanIntegrity, plan }))}`;
  return { schemaVersion: "openclaw.templatesGatewayPlan.v1", planIntegrity, ...plan };
}

function canonicalizeTemplateSourcePlan(value: unknown, sourceRoot: string): unknown {
  const root = path.resolve(sourceRoot);
  return mapNestedStrings(value, (current) => {
    if (path.isAbsolute(current)) {
      const relative = path.relative(root, path.resolve(current));
      if (relative === "") {
        return "$TEMPLATE_SOURCE";
      }
      if (
        !relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative)
      ) {
        return `$TEMPLATE_SOURCE/${relative.split(path.sep).join("/")}`;
      }
      return current;
    }
    return current;
  });
}

function sourceStablePlanIntegrity(plan: { planIntegrity: string }, sourceRoot: string): string {
  const { planIntegrity: _planIntegrity, ...content } = plan;
  return `sha256:${sha256Hex(stableStringify(canonicalizeTemplateSourcePlan(content, sourceRoot)))}`;
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
    stableStringify(canonicalizeTemplateSourcePlan(preview, params.previewRoot)) ===
    stableStringify(canonicalizeTemplateSourcePlan(persisted, params.persistedRoot))
  );
}

export function projectTemplateAddPlan(
  plan: TemplateAddPlan,
  sourceRoot: string,
  pluginReviews: TemplatePluginReview[],
  config: OpenClawConfig,
  source?: Extract<TemplateReadResult, { ok: true }>,
): TemplateLifecyclePlanResult {
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
      let effect: TemplateActionEffect | undefined;
      if (action.kind === "workspaceFile" || action.kind === "bootstrap") {
        const label = sourceLabel(action, sourceRoot);
        if (!action.digest) {
          throw new Error("Template workspace file digest cannot be disclosed.");
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
          throw new Error("Template skill package kind cannot be disclosed.");
        }
        const desired = skillArtifact(action.details);
        assertSkillActionTarget(action, desired);
        if (
          !action.digest ||
          normalizeClawHubSha256Integrity(action.digest) !== desired.integrity
        ) {
          throw new Error("Template skill package integrity does not match its preflight.");
        }
        effect = { type: "skill-package", desired };
      }
      if (!effect) {
        throw new Error("Missing Template action effect.");
      }
      return { ...safe, effect };
    } catch {
      if (!action.blocked) {
        effectBlockers.push({
          code: "effect_disclosure_unavailable",
          path: `$.actions.${action.kind}.${action.id}`,
          message: "This Template effect cannot be reviewed safely. Refresh or repair the plan.",
        });
      }
      return safe;
    }
  });
  let scheduledJobs: TemplateScheduledJobs | undefined;
  try {
    scheduledJobs = projectTemplateAddScheduledJobs(plan);
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
    throw new Error("The Template plugin capability review is incomplete.");
  }
  const agentIdCollision = plan.blockers.some((blocker) => blocker.code === "agent_id_collision");
  const configuredAccess = agentIdCollision
    ? undefined
    : projectTemplateConfiguredAccess({
        config,
        agentId: plan.agent.finalId,
        desiredAgent: plan.agent.config,
        operation: "add",
      });
  return sealTemplateLifecyclePlan(
    {
      operation: "add",
      target: {
        agentId: plan.agent.finalId,
        workspace: plan.agent.workspace,
        name: plan.template.name,
        targetVersion: plan.template.version,
      },
      actions: projectedActions,
      capabilities: plan.capabilityChanges.map((change) => ({
        kind: change.kind,
        id: change.id,
        action: change.action,
        reason: change.reason,
      })),
      pluginReviews,
      skillReviews: collectTemplateSkillWarningReviews(plan).map((review) =>
        Object.assign(review, { reviewToken: digestTemplateValue(review) }),
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
      ...(source
        ? { manifestDisclosure: projectTemplateManifestDisclosure(source, plan.template) }
        : {}),
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

export function bindTemplateLifecycleTrust(
  plan: TemplateLifecyclePlanResult,
  trust: { trustWarning?: string; riskAcknowledgementRequired: boolean },
): TemplateLifecyclePlanResult {
  const { schemaVersion: _schemaVersion, planIntegrity, ...projection } = plan;
  return sealTemplateLifecyclePlan(
    {
      ...projection,
      ...(trust.trustWarning ? { trustWarning: trust.trustWarning } : {}),
      riskAcknowledgementRequired: trust.riskAcknowledgementRequired,
    },
    planIntegrity,
  );
}
