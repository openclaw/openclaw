// Ambient trusted caller context for model-mediated Gateway tool calls.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  parseExecutionIdentityAdmissionToken,
  type ExecutionIdentityAdmissionToken,
} from "../../audit/execution-identity-admission.js";
import {
  resolveAgentExecutionIdentityAdmission,
  type AgentExecutionAttribution,
} from "../agent-execution-attribution.js";
import { copyAgentToolMetadata } from "../agent-tool-metadata.js";
import type { AnyAgentTool } from "./common.js";

export type GatewayToolCallerIdentity = {
  agentId: string;
  sessionKey: string;
  executionIdentity?: ExecutionIdentityAdmissionToken;
  /** Host-signed capability for the scheduled run's existing self-management surface. */
  cronSelfManagementJobId?: string;
  // Trusted run context, carried separately from model-authored tool arguments.
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

type GatewayToolCallerSource = {
  agentSessionKey?: string;
  agentChannel?: string;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  agentTo?: string;
  agentAccountId?: string;
  currentThreadTs?: string;
  agentThreadId?: string | number;
};

type GatewayToolCallerAuthority = {
  attribution?: AgentExecutionAttribution;
  executionIdentityEnabled?: boolean;
};

const gatewayToolCallerStorage = new AsyncLocalStorage<GatewayToolCallerIdentity>();

export function captureGatewayToolCallerIdentity(
  agentId: string | undefined,
  source: GatewayToolCallerSource | undefined,
  authority?: GatewayToolCallerAuthority,
): GatewayToolCallerIdentity | undefined {
  const executionIdentity =
    authority?.executionIdentityEnabled && authority.attribution
      ? resolveAgentExecutionIdentityAdmission(authority.attribution).token
      : undefined;
  return agentId && source?.agentSessionKey?.trim()
    ? {
        agentId,
        sessionKey: source.agentSessionKey.trim(),
        ...(executionIdentity ? { executionIdentity } : {}),
        turnSourceChannel: source.agentChannel,
        turnSourceTo: source.currentMessagingTarget ?? source.currentChannelId ?? source.agentTo,
        turnSourceAccountId: source.agentAccountId,
        turnSourceThreadId: source.currentThreadTs ?? source.agentThreadId,
      }
    : undefined;
}

export function getGatewayToolCallerIdentity(): GatewayToolCallerIdentity | undefined {
  return gatewayToolCallerStorage.getStore();
}

export async function withGatewayToolCallerIdentity<T>(
  identity: GatewayToolCallerIdentity | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  if (!identity?.agentId?.trim() || !identity.sessionKey?.trim()) {
    return await run();
  }
  return await gatewayToolCallerStorage.run(
    {
      agentId: identity.agentId.trim(),
      sessionKey: identity.sessionKey.trim(),
      ...(identity.executionIdentity
        ? { executionIdentity: parseExecutionIdentityAdmissionToken(identity.executionIdentity) }
        : {}),
      ...(identity.cronSelfManagementJobId?.trim()
        ? { cronSelfManagementJobId: identity.cronSelfManagementJobId.trim() }
        : {}),
      ...(identity.turnSourceChannel?.trim()
        ? { turnSourceChannel: identity.turnSourceChannel.trim() }
        : {}),
      ...(identity.turnSourceTo?.trim() ? { turnSourceTo: identity.turnSourceTo.trim() } : {}),
      ...(identity.turnSourceAccountId?.trim()
        ? { turnSourceAccountId: identity.turnSourceAccountId.trim() }
        : {}),
      ...(identity.turnSourceThreadId !== undefined
        ? { turnSourceThreadId: identity.turnSourceThreadId }
        : {}),
    },
    run,
  );
}

function wrapToolWithGatewayCallerIdentity(
  tool: AnyAgentTool,
  identity: GatewayToolCallerIdentity | undefined,
): AnyAgentTool {
  if (!identity?.agentId?.trim() || !identity.sessionKey?.trim() || !tool.execute) {
    return tool;
  }
  const wrapped: AnyAgentTool = {
    ...tool,
    execute: async (...args) =>
      await withGatewayToolCallerIdentity(identity, async () => await tool.execute?.(...args)),
  };
  return copyAgentToolMetadata(tool, wrapped);
}

export function createGatewayToolCallerWrapper(
  agentId: string | undefined,
  source: GatewayToolCallerSource | undefined,
  authority?: GatewayToolCallerAuthority,
): (tool: AnyAgentTool) => AnyAgentTool {
  const identity = captureGatewayToolCallerIdentity(agentId, source, authority);
  return (tool) => wrapToolWithGatewayCallerIdentity(tool, identity);
}
