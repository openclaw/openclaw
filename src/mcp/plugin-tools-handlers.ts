// Plugin MCP tool handlers route plugin tool calls through the active runtime.
import {
  isToolWrappedWithBeforeToolCallHook,
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agents/agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { formatErrorMessage } from "../infra/errors.js";
import { coerceChatContentText } from "../shared/chat-content.js";

type CallPluginToolParams = {
  name: string;
  arguments?: unknown;
};

function emptyInputSchema(): Record<string, unknown> {
  return { type: "object", properties: {} };
}

function resolveJsonSchemaForTool(tool: AnyAgentTool): Record<string, unknown> | undefined {
  try {
    const params = Reflect.get(tool, "parameters");
    if (params && typeof params === "object" && Reflect.has(params, "type")) {
      return params as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return emptyInputSchema();
}

export function createPluginToolsMcpHandlers(tools: AnyAgentTool[]) {
  const wrappedTools = tools.map((tool) => {
    if (isToolWrappedWithBeforeToolCallHook(tool)) {
      return rewrapToolWithBeforeToolCallHook(tool, undefined, { approvalMode: "report" });
    }
    // The ACPX MCP bridge should enforce the same pre-execution hook boundary
    // as the agent and HTTP tool execution paths.
    return wrapToolWithBeforeToolCallHook(tool, undefined, { approvalMode: "report" });
  });
  const listedTools: Array<{
    tool: AnyAgentTool;
    inputSchema: Record<string, unknown>;
  }> = [];
  for (const tool of wrappedTools) {
    const inputSchema = resolveJsonSchemaForTool(tool);
    if (inputSchema) {
      listedTools.push({ tool, inputSchema });
    }
  }
  const toolMap = new Map<string, AnyAgentTool>();
  for (const { tool } of listedTools) {
    toolMap.set(tool.name, tool);
  }

  return {
    listTools: async () => ({
      tools: listedTools.map(({ tool, inputSchema }) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema,
      })),
    }),
    callTool: async (params: CallPluginToolParams, signal?: AbortSignal) => {
      const tool = toolMap.get(params.name);
      if (!tool) {
        return {
          content: [{ type: "text", text: `Unknown tool: ${params.name}` }],
          isError: true,
        };
      }
      try {
        const result = await tool.execute(`mcp-${Date.now()}`, params.arguments ?? {}, signal);
        const rawContent =
          result && typeof result === "object" && "content" in result
            ? (result as { content?: unknown }).content
            : result;
        return {
          content: Array.isArray(rawContent)
            ? rawContent
            : [{ type: "text", text: coerceChatContentText(rawContent) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Tool error: ${formatErrorMessage(err)}` }],
          isError: true,
        };
      }
    },
  };
}
