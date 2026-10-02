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
import { isPathInside } from "../infra/path-guards.js";
import { normalizeAgentId } from "../routing/session-key.js";
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
  const agentId = normalizeAgentId(context.agentId ?? source.manifest.agent.id);
  const configuredWorkspace = resolveAgentWorkspaceDir(context.config, agentId);
  const existingWorkspaces = existingAgentIds.map((existingAgentId) => ({
    agentId: normalizeAgentId(existingAgentId),
    workspace: resolveAgentWorkspaceDir(context.config, existingAgentId),
  }));
  const canonicalConfiguredWorkspace = resolveCanonicalWorkspacePath(configuredWorkspace);
  const overlapsExistingWorkspace = existingWorkspaces.some((existing) => {
    if (existing.agentId === agentId) {
      return false;
    }
    const canonicalExistingWorkspace = resolveCanonicalWorkspacePath(existing.workspace);
    return (
      isPathInside(canonicalExistingWorkspace, canonicalConfiguredWorkspace) ||
      isPathInside(canonicalConfiguredWorkspace, canonicalExistingWorkspace)
    );
  });
  const workspace =
    !resolveAgentConfig(context.config, agentId)?.workspace && overlapsExistingWorkspace
      ? path.join(resolveStateDir(), `workspace-${agentId}`)
      : configuredWorkspace;
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
  sourceRoot: string,
  trust: ClawHubClawTrust,
  config: OpenClawConfig,
): ClawLifecyclePlanResult {
  const pluginReviews = projectClawPluginCapabilityReviews(plan);
  return bindClawLifecycleTrust(projectClawAddPlan(plan, sourceRoot, pluginReviews, config), trust);
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
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    run: async (source, trust) => {
      const plan = await buildGatewayClawAddPlan(source, input);
      return projectGatewayClawAddPlan(plan, source.source.packageRoot, trust, input.config);
    },
  });
  return resolved.value;
}
