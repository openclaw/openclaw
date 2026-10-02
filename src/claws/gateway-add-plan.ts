import type { ClawLifecyclePlanResult } from "../../packages/gateway-protocol/src/schema/claws.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ClawHubFetchOptions } from "../infra/clawhub-client.js";
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
      workspace: resolveAgentWorkspaceDir(
        context.config,
        context.agentId ?? source.manifest.agent.id,
      ),
      existingAgentIds,
      existingWorkspacePaths: existingAgentIds.map((agentId) =>
        resolveAgentWorkspaceDir(context.config, agentId),
      ),
      existingMcpServers: context.sourceMcpServers,
      packagePreflight:
        context.packagePreflight ??
        ((pkg, workspace) => preflightClawPackage(pkg, workspace, { config: context.config })),
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
