import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agents/agent-tools.before-tool-call.js";
import {
  projectRuntimeToolInputSchema,
  type RuntimeToolSchemaDiagnostic,
} from "../agents/tool-schema-projection.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import { coerceChatContentText } from "../shared/chat-content.js";

type CallPluginToolParams = {
  name: string;
  arguments?: unknown;
};

type ListedPluginMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type PluginMcpToolEntry =
  | {
      ok: true;
      tool: AnyAgentTool;
      listedTool: ListedPluginMcpTool;
    }
  | {
      ok: false;
      diagnostic: RuntimeToolSchemaDiagnostic;
    };

function emptyObjectInputSchema(): Record<string, unknown> {
  return { type: "object", properties: {} };
}

function objectInputSchema(schema: unknown): Record<string, unknown> {
  return { ...(schema as Record<string, unknown>), type: "object" };
}

function validatePluginMcpTool(
  tool: AnyAgentTool,
  toolIndex: number,
  listedTool: ListedPluginMcpTool,
): PluginMcpToolEntry {
  const parsed = ToolSchema.safeParse(listedTool);
  if (parsed.success) {
    return { ok: true, tool, listedTool };
  }
  return {
    ok: false,
    diagnostic: {
      toolName: listedTool.name,
      toolIndex,
      violations: parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "tool";
        return `${listedTool.name}.${path}: ${issue.message}`;
      }),
    },
  };
}

function readPluginMcpToolDescription(tool: AnyAgentTool): string {
  try {
    return typeof tool.description === "string" ? tool.description : "";
  } catch {
    return "";
  }
}

function materializePluginMcpTool(tool: AnyAgentTool, toolIndex: number): PluginMcpToolEntry {
  let toolName: string;
  try {
    toolName = tool.name;
  } catch {
    return {
      ok: false,
      diagnostic: {
        toolName: `tool[${toolIndex}]`,
        toolIndex,
        violations: [`tool[${toolIndex}].name is unreadable`],
      },
    };
  }
  const description = readPluginMcpToolDescription(tool);
  let parameters: unknown;
  try {
    parameters = tool.parameters;
  } catch {
    return {
      ok: false,
      diagnostic: {
        toolName,
        toolIndex,
        violations: [`${toolName}.parameters is unreadable`],
      },
    };
  }
  if (parameters === undefined || parameters === null) {
    return validatePluginMcpTool(tool, toolIndex, {
      name: toolName,
      description,
      inputSchema: emptyObjectInputSchema(),
    });
  }
  const projection = projectRuntimeToolInputSchema(parameters, `${toolName}.parameters`);
  if (projection.violations.length > 0) {
    return {
      ok: false,
      diagnostic: {
        toolName,
        toolIndex,
        violations: projection.violations,
      },
    };
  }
  return validatePluginMcpTool(tool, toolIndex, {
    name: toolName,
    description,
    inputSchema: objectInputSchema(projection.schema),
  });
}

function logPluginMcpSchemaQuarantine(diagnostics: readonly RuntimeToolSchemaDiagnostic[]) {
  if (diagnostics.length === 0) {
    return;
  }
  const summary = diagnostics
    .map((diagnostic) => `${diagnostic.toolName}: ${diagnostic.violations.join(", ")}`)
    .join("; ");
  logWarn(
    `plugin-tools-mcp: quarantined ${diagnostics.length} unsupported tool schema${diagnostics.length === 1 ? "" : "s"} before MCP tool listing: ${summary}.`,
  );
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
  const materializedTools: { tool: AnyAgentTool; listedTool: ListedPluginMcpTool }[] = [];
  const diagnostics: RuntimeToolSchemaDiagnostic[] = [];
  for (const [toolIndex, tool] of wrappedTools.entries()) {
    const entry = materializePluginMcpTool(tool, toolIndex);
    if (entry.ok) {
      materializedTools.push({ tool: entry.tool, listedTool: entry.listedTool });
    } else {
      diagnostics.push(entry.diagnostic);
    }
  }
  logPluginMcpSchemaQuarantine(diagnostics);

  const toolMap = new Map<string, AnyAgentTool>();
  for (const entry of materializedTools) {
    toolMap.set(entry.listedTool.name, entry.tool);
  }

  return {
    listTools: async () => ({
      tools: materializedTools.map((entry) => entry.listedTool),
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
