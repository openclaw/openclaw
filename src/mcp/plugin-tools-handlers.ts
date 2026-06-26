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

type PluginMcpToolEntry = {
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
  tool: AnyAgentTool;
};

function readToolName(tool: AnyAgentTool): string | undefined {
  try {
    const value = tool.name;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readToolDescription(tool: AnyAgentTool): string {
  try {
    return typeof tool.description === "string" ? tool.description : "";
  } catch {
    return "";
  }
}

function readToolParameters(tool: AnyAgentTool): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: tool.parameters };
  } catch {
    return { ok: false };
  }
}

function resolveJsonSchemaForTool(
  tool: AnyAgentTool,
): { ok: true; schema: Record<string, unknown> } | { ok: false } {
  const params = readToolParameters(tool);
  if (!params.ok) {
    return { ok: false };
  }
  try {
    if (params.value && typeof params.value === "object" && "type" in params.value) {
      return { ok: true, schema: params.value as Record<string, unknown> };
    }
  } catch {
    return { ok: false };
  }
  return { ok: true, schema: { type: "object", properties: {} } };
}

export function createPluginToolsMcpHandlers(tools: AnyAgentTool[]) {
  const toolEntries: PluginMcpToolEntry[] = [];
  for (const tool of tools) {
    const name = readToolName(tool);
    if (!name) {
      continue;
    }
    const inputSchema = resolveJsonSchemaForTool(tool);
    if (!inputSchema.ok) {
      continue;
    }
    const description = readToolDescription(tool);
    let wrappedTool: AnyAgentTool;
    try {
      // The ACPX MCP bridge should enforce the same pre-execution hook boundary
      // as the agent and HTTP tool execution paths.
      wrappedTool = isToolWrappedWithBeforeToolCallHook(tool)
        ? rewrapToolWithBeforeToolCallHook(tool, undefined, { approvalMode: "report" })
        : wrapToolWithBeforeToolCallHook(tool, undefined, { approvalMode: "report" });
    } catch {
      continue;
    }
    toolEntries.push({
      description,
      inputSchema: inputSchema.schema,
      name,
      tool: wrappedTool,
    });
  }
  const toolMap = new Map<string, AnyAgentTool>();
  for (const entry of toolEntries) {
    toolMap.set(entry.name, entry.tool);
  }

  return {
    listTools: async () => ({
      tools: toolEntries.map((entry) => ({
        name: entry.name,
        description: entry.description,
        inputSchema: entry.inputSchema,
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
