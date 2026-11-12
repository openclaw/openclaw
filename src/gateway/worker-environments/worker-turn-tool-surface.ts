import { WORKER_LOCAL_MCP_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerToolSurface } from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import {
  bindAgentToolExecutionLocation,
  copyAgentToolMetadata,
  getAgentToolExecutionLocation,
} from "../../agents/agent-tool-metadata.js";
import { hasBeforeToolCallPolicy } from "../../agents/agent-tools.before-tool-call.js";
import { isGatewayToolAllowedWithoutAction } from "../../agents/gateway-tool-policy.js";
import { createMcpClientElicitationHandler } from "../../agents/mcp-client-elicitation.js";
import { resolveToolLoopDetectionConfig } from "../../agents/tool-loop-detection-config.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logInfo } from "../../logger.js";
import { hasGlobalHooks } from "../../plugins/hook-runner-global.js";
import { getGatewayContextResolver } from "../../plugins/runtime/gateway-context-binding.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import type { WorkerToolAuthority } from "../../worker/launch-descriptor.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import { assertWorkerTurnInputAdmitted } from "./placement-turn-claim-events.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import type { prepareWorkerDesktopLaunchPlan } from "./worker-desktop-launch-plan.js";
import type { prepareWorkerAgentRuntimeIdentity } from "./worker-turn-payload.js";

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

type WorkerLaunchToolSetup = Pick<
  Awaited<ReturnType<typeof prepareWorkerAgentRuntimeIdentity>>,
  "admittedRunContext" | "capability" | "runtimeIdentity" | "assertActive"
> & {
  surface: WorkerToolSurface;
  localMcpNodeId?: string;
  exec: WorkerToolAuthority["exec"];
  connectionIdentity: WorkerConnectionIdentity;
  placements: WorkerSessionPlacementStore;
  questionsEnabled: boolean;
  assertToolSurfaceCurrent: () => void;
  assertTurnInputCurrent: () => void;
  preparedComputer: Awaited<ReturnType<typeof prepareWorkerDesktopLaunchPlan>>["preparedComputer"];
  isAuthorized: () => boolean;
  signal: AbortSignal;
  mcpQuestions: DisposableStack;
};

export async function prepareWorkerLaunchTools(params: WorkerLaunchToolSetup) {
  const { surface, runtimeIdentity } = params;
  const allowedToolNames = surface.tools.map((tool) => tool.definition.name);
  await params.placements.authorizeWorkerTurnTools(
    runtimeIdentity.workerTurnClaim,
    allowedToolNames,
    params.assertTurnInputCurrent,
  );
  if (allowedToolNames.includes("computer")) {
    params.preparedComputer?.bind(runtimeIdentity.operationalRunInstance, {
      authority: runtimeIdentity.approvalAuthority,
      assertCurrent: params.assertActive,
    });
  }
  return { allowedToolNames, issueLaunchAuthority: () => issueWorkerLaunchToolAuthority(params) };
}

/** Issue grants only after turn input and replay admission have passed. */
function issueWorkerLaunchToolAuthority(params: WorkerLaunchToolSetup): WorkerToolAuthority {
  const { localMcpNodeId, capability, runtimeIdentity, surface } = params;
  const resolveGatewayContext = getGatewayContextResolver(params.admittedRunContext);
  const gateway = params.questionsEnabled && localMcpNodeId ? resolveGatewayContext?.() : undefined;
  const node = localMcpNodeId && gateway?.nodeRegistry.get(localMcpNodeId);
  const mcpTools: NonNullable<WorkerToolAuthority["mcpTools"]> = [];
  for (const { id, definition, execution, plugin } of surface.tools) {
    const mcp = plugin?.mcp;
    if (execution !== "placement" || !mcp?.node) {
      continue;
    }
    const handle = { id, server: mcp.serverName, tool: mcp.toolName };
    if (!gateway || !node || node.nodeId !== mcp.node.id) {
      mcpTools.push(handle);
      continue;
    }
    const assertCurrent = () => {
      params.assertToolSurfaceCurrent();
      assertWorkerTurnInputAdmitted(params.connectionIdentity);
      if (
        !params.isAuthorized() ||
        resolveGatewayContext?.() !== gateway ||
        !params.placements.isWorkerTurnToolAuthorized(
          runtimeIdentity.workerTurnClaim,
          definition.name,
        )
      ) {
        throw new Error("Worker MCP question lost its turn authority");
      }
    };
    const elicit = createMcpClientElicitationHandler({
      agentId: runtimeIdentity.agentId,
      sessionKey: runtimeIdentity.sessionKey,
      assertCurrent,
    });
    params.mcpQuestions.defer(
      gateway.nodeRegistry.mcpElicitation.register({
        id,
        node,
        signal: params.signal,
        handle: (request) =>
          capability.run((owner) =>
            withGatewayToolCallerIdentity(
              {
                ...owner,
                ...runtimeIdentity,
                receiptAuthority: assertCurrent,
                gatewayContextResolver: resolveGatewayContext,
                workerTurnExecutionIdentityCapability: capability,
              },
              () => elicit(request),
            ),
          ),
      }),
    );
    mcpTools.push({ ...handle, allowElicitation: true });
  }
  return {
    exec: params.exec,
    ...(mcpTools.length && { mcpTools }),
    allowedToolNames: surface.tools
      .filter((tool) => tool.execution === "placement")
      .map((tool) => tool.definition.name),
  };
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
