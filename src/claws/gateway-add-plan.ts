import { lstat } from "node:fs/promises";
import path from "node:path";
import type { ClawLifecyclePlanResult } from "../../packages/gateway-protocol/src/schema/claws.js";
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
import { selectNextClawAgentId } from "./add-agent-id.js";
import {
  withResolvedClawHubSource,
  type ClawHubClawTrust,
  type ClawHubCoordinate,
} from "./clawhub-source.js";
import { bindClawLifecycleTrust, projectClawAddPlan } from "./gateway-plan-projection.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { preflightClawPackage } from "./packages.js";
import { projectClawPluginCapabilityReviews } from "./plugin-capability-review.js";
import type { ClawAddPlan, ClawPackagePreflight, ClawReadResult } from "./types.js";

type VerifiedClawSource = Extract<ClawReadResult, { ok: true }>;

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
  throw new Error("No available Claw workspace suffix");
}

export type GatewayClawAddPlanningContext = {
  config: OpenClawConfig;
  sourceMcpServers: Record<string, Record<string, unknown>>;
  agentId?: string;
  packagePreflight?: ClawPackagePreflight;
};

export async function buildGatewayClawAddPlan(
  source: VerifiedClawSource,
  context: GatewayClawAddPlanningContext,
): Promise<ClawAddPlan> {
  const existingAgentIds = listAgentIds(context.config);
  const agentId = context.agentId
    ? normalizeAgentId(context.agentId)
    : selectNextClawAgentId(source.manifest.agent.id, existingAgentIds);
  const configuredWorkspace = resolveAgentWorkspaceDir(context.config, agentId);
  const existingWorkspaces = existingAgentIds.map((existingAgentId) => ({
    agentId: normalizeAgentId(existingAgentId),
    workspace: resolveAgentWorkspaceDir(context.config, existingAgentId),
  }));
  const claimedWorkspaces = existingWorkspaces
    .filter((existing) => existing.agentId !== agentId)
    .map((existing) => resolveCanonicalWorkspacePath(existing.workspace));
  const overlapsConfiguredWorkspace = claimedWorkspaces.some((workspace) =>
    workspacesOverlap(workspace, resolveCanonicalWorkspacePath(configuredWorkspace)),
  );
  const baseWorkspace =
    !resolveAgentConfig(context.config, agentId)?.workspace && overlapsConfiguredWorkspace
      ? path.join(resolveStateDir(), `workspace-${agentId}`)
      : configuredWorkspace;
  const workspace = existingWorkspaces.some((existing) => existing.agentId === agentId)
    ? baseWorkspace
    : await selectNewWorkspace(baseWorkspace, claimedWorkspaces);
  return await buildClawAddPlan({
    manifest: source.manifest,
    clawMarkdownBody: source.clawMarkdownBody,
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
      existingWorkspacePaths: existingWorkspaces.map((existing) => existing.workspace),
      existingMcpServers: context.sourceMcpServers,
      packagePreflight:
        context.packagePreflight ??
        ((pkg, destinationWorkspace) =>
          preflightClawPackage(pkg, destinationWorkspace, { config: context.config })),
    },
  });
}

export function projectGatewayClawAddPlan(
  plan: ClawAddPlan,
  source: VerifiedClawSource,
  trust: ClawHubClawTrust,
  config: OpenClawConfig,
): ClawLifecyclePlanResult {
  const pluginReviews = projectClawPluginCapabilityReviews(plan);
  return bindClawLifecycleTrust(
    projectClawAddPlan(plan, source.source.packageRoot, pluginReviews, config, source),
    trust,
  );
}

export async function planClawAddForGateway(
  input: GatewayClawAddPlanningContext &
    ClawHubFetchOptions & {
      source: ClawHubCoordinate;
    },
): Promise<ClawLifecyclePlanResult> {
  const resolved = await withResolvedClawHubSource({
    coordinate: input.source,
    mode: "preview",
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.token ? { token: input.token } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    run: async (source, trust) => {
      const plan = await buildGatewayClawAddPlan(source, input);
      return projectGatewayClawAddPlan(plan, source, trust, input.config);
    },
  });
  return resolved.value;
}
