import { WORKER_LOCAL_MCP_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerToolSurface } from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import {
  bindAgentToolExecutionLocation,
  copyAgentToolMetadata,
  getAgentToolExecutionLocation,
} from "../../agents/agent-tool-metadata.js";
import { hasBeforeToolCallPolicy } from "../../agents/agent-tools.before-tool-call.js";
import { resolveToolLoopDetectionConfig } from "../../agents/agent-tools.js";
import { isGatewayToolAllowedWithoutAction } from "../../agents/gateway-tool-policy.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logInfo } from "../../logger.js";
import { hasGlobalHooks } from "../../plugins/hook-runner-global.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";

export async function resolveLocalMcpNodeId(
  { nodeDeviceId: nodeId }: { nodeDeviceId?: string | null },
  { protocolFeatures }: { protocolFeatures: readonly string[] },
  tunnel: WorkerTurnTunnelHandle,
) {
  return nodeId &&
    protocolFeatures.includes(WORKER_LOCAL_MCP_PROTOCOL_FEATURE) &&
    (await tunnel.supportsLocalMcp?.())
    ? nodeId
    : undefined;
}

/** Retain the Gateway executor unless a policy-admitted tool can run unchanged at this placement. */
export function retainWorkerTurnTools(
  tools: AnyAgentTool[],
  options: {
    localMcpNodeId?: string;
    config?: OpenClawConfig;
    agentId: string;
    runPrepared: <T>(run: () => T) => T;
  },
): AnyAgentTool[] {
  const canPlace =
    options.localMcpNodeId &&
    options.runPrepared(
      () =>
        !hasBeforeToolCallPolicy() &&
        !hasGlobalHooks("after_tool_call") &&
        !resolveToolLoopDetectionConfig({ cfg: options.config, agentId: options.agentId })?.enabled,
    );
  return tools.map((tool) => {
    const retained = copyAgentToolMetadata(tool, {
      ...tool,
      execute: (...args) => options.runPrepared(() => tool.execute(...args)),
    });
    const mcp = getPluginToolMeta(tool)?.mcp;
    if (
      canPlace &&
      mcp?.operation === "tool" &&
      mcp.node?.id === options.localMcpNodeId &&
      isGatewayToolAllowedWithoutAction(tool.name, options.config)
    ) {
      bindAgentToolExecutionLocation(retained, { kind: "placement" });
    }
    return retained;
  });
}

export function collectWorkerMcpGrants(surface: WorkerToolSurface) {
  return surface.tools.flatMap(({ id, execution, plugin }) =>
    execution === "placement" && plugin?.mcp?.node
      ? [{ id, server: plugin.mcp.serverName, tool: plugin.mcp.toolName }]
      : [],
  );
}

export function filterWorkerPlacementTools(
  tools: AnyAgentTool[],
  availablePlacementTools: ReadonlySet<string>,
  launchToolNames: readonly string[],
) {
  return tools.filter((tool) => {
    const location = getAgentToolExecutionLocation(tool);
    const reason =
      location.kind === "gateway"
        ? location.unavailableReason
        : !availablePlacementTools.has(tool.name) || !launchToolNames.includes(tool.name)
          ? "the placement has no available execution capability"
          : undefined;
    if (reason) {
      logInfo(`Worker tool ${tool.name} withheld: ${reason}.`);
    }
    return !reason;
  });
}
