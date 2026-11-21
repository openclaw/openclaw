import { runWithSessionMcpToolCallAuthority } from "../agents/agent-bundle-mcp-request-context.js";
import { createOperationalRunInstanceRef } from "../agents/operational-run-instance.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { readOperatorToolGatewayAuthority } from "./operator-tool-gateway-authority.js";

type DirectToolInvocation = {
  signal: AbortSignal;
  messageChannel?: string;
  agentTo?: string;
  accountId?: string;
  agentThreadId?: string;
};

type DirectToolCall = {
  agentId: string;
  sessionKey: string;
  toolCallId: string;
  tool: AnyAgentTool;
  /** The session's resolved tool surface; nested tool calls must stay inside it. */
  tools: readonly AnyAgentTool[];
};

/**
 * Executes one tools.invoke (RPC or HTTP) tool call.
 *
 * A direct call runs as the operator's own agent in the target session: the caller identity an
 * agent run gives its tools, bounded by the session's tool surface and the operator's scopes, so
 * plugins that call back into Gateway methods see an active tool invocation. Calls made from inside
 * an agent run keep that run's caller.
 */
export async function runDirectToolCall(
  invocation: DirectToolInvocation,
  call: DirectToolCall,
  args: unknown,
  assertCurrent: () => void,
): Promise<unknown> {
  // MCP requests recheck caller authority at server I/O, after reconnection or catalog waits.
  const execute = () =>
    runWithSessionMcpToolCallAuthority(
      getPluginToolMeta(call.tool)?.mcp ? assertCurrent : undefined,
      () => call.tool.execute?.(call.toolCallId, args, invocation.signal),
    );
  if (getGatewayToolCallerIdentity()) {
    return await execute();
  }
  const allowedTools = new Set(call.tools.map((tool) => tool.name));
  const operator = readOperatorToolGatewayAuthority();
  return await withGatewayToolCallerIdentity(
    {
      agentId: call.agentId,
      sessionKey: call.sessionKey,
      operationalRunInstance: createOperationalRunInstanceRef(call.toolCallId),
      ...(operator?.operatorRunAuthority
        ? { operatorAuthority: operator.operatorRunAuthority }
        : {}),
      receiptAuthority: assertCurrent,
      assertToolAllowed: (toolName) => {
        if (!allowedTools.has(toolName)) {
          throw new Error(`Tool not available in this session: ${toolName}`);
        }
      },
      approvalSignals: operator ? [invocation.signal, operator.signal] : [invocation.signal],
      turnSourceChannel: invocation.messageChannel,
      turnSourceTo: invocation.agentTo,
      turnSourceAccountId: invocation.accountId,
      turnSourceThreadId: invocation.agentThreadId,
    },
    execute,
  );
}
