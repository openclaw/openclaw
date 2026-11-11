import { lstat } from "node:fs/promises";
import path from "node:path";
import type { TemplateLifecyclePlanResult } from "../../packages/gateway-protocol/src/schema/templates.js";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope-config.js";
import { resolveCanonicalWorkspacePath } from "../agents/workspace-state-identity.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ClawHubFetchOptions } from "../infra/clawhub-client.js";
import { hasErrnoCode } from "../infra/errno.js";
import { isPathInside } from "../infra/path-guards.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { selectNextTemplateAgentId } from "./add-agent-id.js";
import {
  withResolvedClawHubSource,
  type ClawHubTemplateTrust,
  type ClawHubCoordinate,
} from "./clawhub-source.js";
import { bindTemplateLifecycleTrust, projectTemplateAddPlan } from "./gateway-plan-projection.js";
import { buildTemplateAddPlan } from "./lifecycle.js";
import { preflightTemplatePackage } from "./packages.js";
import { projectTemplatePluginCapabilityReviews } from "./plugin-capability-review.js";
import type { TemplateAddPlan, TemplatePackagePreflight, TemplateReadResult } from "./types.js";

type VerifiedTemplateSource = Extract<TemplateReadResult, { ok: true }>;

function workspacesOverlap(left: string, right: string): boolean {
  return isPathInside(left, right) || isPathInside(right, left);
}

async function selectNewWorkspace(
  base: string,
  claimedWorkspaces: readonly string[],
): Promise<string> {
  const canonicalParent = resolveCanonicalWorkspacePath(path.dirname(base));
  if (claimedWorkspaces.some((workspace) => isPathInside(workspace, canonicalParent))) {
    return base;
  }
  for (let index = 1; Number.isSafeInteger(index); index += 1) {
    const candidate = index === 1 ? base : `${base}-${index}`;
    const canonicalCandidate = resolveCanonicalWorkspacePath(candidate);
    if (claimedWorkspaces.some((workspace) => workspacesOverlap(workspace, canonicalCandidate))) {
      continue;
    }
    try {
      await lstat(candidate);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return candidate;
      }
      throw error;
    }
  }
  throw new Error("No available Template workspace suffix");
}

export async function selectTemplateAgentWorkspace(
  config: OpenClawConfig,
  agentId: string,
): Promise<string> {
  const existingAgentIds = listAgentIds(config);
  const configuredWorkspace = resolveAgentWorkspaceDir(config, agentId);
  const existingWorkspaces = existingAgentIds.map((existingAgentId) => ({
    agentId: normalizeAgentId(existingAgentId),
    workspace: resolveAgentWorkspaceDir(config, existingAgentId),
  }));
  const claimedWorkspaces = existingWorkspaces
    .filter((existing) => existing.agentId !== agentId)
    .map((existing) => resolveCanonicalWorkspacePath(existing.workspace));
  const overlapsConfiguredWorkspace = claimedWorkspaces.some((workspace) =>
    workspacesOverlap(workspace, resolveCanonicalWorkspacePath(configuredWorkspace)),
  );
  const baseWorkspace =
    !resolveAgentConfig(config, agentId)?.workspace && overlapsConfiguredWorkspace
      ? path.join(resolveStateDir(), `workspace-${agentId}`)
      : configuredWorkspace;
  return existingWorkspaces.some((existing) => existing.agentId === agentId)
    ? baseWorkspace
    : await selectNewWorkspace(baseWorkspace, claimedWorkspaces);
}

export type GatewayTemplateAddPlanningContext = {
  config: OpenClawConfig;
  sourceMcpServers:
    | Record<string, Record<string, unknown>>
    | (() => Promise<Record<string, Record<string, unknown>>>);
  agentId?: string;
  /** Trusted in-flight creation receipt; never a wire field. */
  admittedWorkspace?: string;
  packagePreflight?: TemplatePackagePreflight;
};

export async function buildGatewayTemplateAddPlan(
  source: VerifiedTemplateSource,
  context: GatewayTemplateAddPlanningContext,
): Promise<TemplateAddPlan> {
  const existingAgentIds = listAgentIds(context.config);
  const agentId = context.agentId
    ? normalizeAgentId(context.agentId)
    : selectNextTemplateAgentId(source.manifest.agent.id, existingAgentIds);
  const workspace =
    context.admittedWorkspace ?? (await selectTemplateAgentWorkspace(context.config, agentId));
  const existingWorkspaces = existingAgentIds.map((id) =>
    resolveAgentWorkspaceDir(context.config, id),
  );
  return await buildTemplateAddPlan({
    manifest: source.manifest,
    templateMarkdownBody: source.templateMarkdownBody,
    packageBootstrap: source.packageBootstrap,
    openClawProfile: source.openClawProfile,
    source: source.source,
    diagnostics: source.diagnostics,
    context: {
      config: context.config,
      ...(context.agentId ? { agentId: context.agentId } : {}),
      ...(!context.agentId ? { agentId } : {}),
      workspace,
      existingAgentIds,
      existingWorkspacePaths: existingWorkspaces,
      ...(context.admittedWorkspace ? { admittedWorkspace: context.admittedWorkspace } : {}),
      // Most Templates have no MCP declarations. Do not read and validate the
      // entire authored host configuration for an unrelated requirement type.
      existingMcpServers:
        Object.keys(source.manifest.mcpServers).length === 0
          ? {}
          : typeof context.sourceMcpServers === "function"
            ? await context.sourceMcpServers()
            : context.sourceMcpServers,
      packagePreflight:
        context.packagePreflight ??
        ((pkg, destinationWorkspace) =>
          preflightTemplatePackage(pkg, destinationWorkspace, { config: context.config })),
    },
  });
}

export function projectGatewayTemplateAddPlan(
  plan: TemplateAddPlan,
  source: VerifiedTemplateSource,
  trust: ClawHubTemplateTrust,
  config: OpenClawConfig,
): TemplateLifecyclePlanResult {
  const pluginReviews = projectTemplatePluginCapabilityReviews(plan);
  return bindTemplateLifecycleTrust(
    projectTemplateAddPlan(plan, source.source.packageRoot, pluginReviews, config, source),
    trust,
  );
}

export async function planTemplateAddForGateway(
  input: GatewayTemplateAddPlanningContext &
    ClawHubFetchOptions & {
      source: ClawHubCoordinate;
    },
): Promise<TemplateLifecyclePlanResult> {
  const resolved = await withResolvedClawHubSource({
    coordinate: input.source,
    mode: "preview",
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.token ? { token: input.token } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    run: async (source, trust) => {
      const plan = await buildGatewayTemplateAddPlan(source, input);
      return projectGatewayTemplateAddPlan(plan, source, trust, input.config);
    },
  });
  return resolved.value;
}
