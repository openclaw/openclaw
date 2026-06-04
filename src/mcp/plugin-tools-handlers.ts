import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agents/agent-tools.before-tool-call.js";
import { projectRuntimeToolInputSchema } from "../agents/tool-schema-projection.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { formatErrorMessage } from "../infra/errors.js";
import { coerceChatContentText } from "../shared/chat-content.js";

type CallPluginToolParams = {
  name: string;
  arguments?: unknown;
};

type McpPluginToolSnapshot = {
  tool: AnyAgentTool;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type McpPluginToolEntryRead =
  | {
      readable: true;
      tool: AnyAgentTool;
      toolIndex: number;
    }
  | {
      readable: false;
      toolName: string;
      violations: readonly string[];
    };

export function createPluginToolsMcpHandlers(tools: AnyAgentTool[]) {
  const snapshots = snapshotMcpPluginTools(tools);
  const wrappedTools = snapshots.map(({ tool, name, description, inputSchema }) => {
    const wrapped = isToolWrappedWithBeforeToolCallHook(tool)
      ? rewrapToolWithBeforeToolCallHook(tool, undefined, { approvalMode: "report" })
      : wrapToolWithBeforeToolCallHook(tool, undefined, { approvalMode: "report" });
    return { tool: wrapped, name, description, inputSchema };
  });
  const toolMap = new Map<string, AnyAgentTool>();
  for (const entry of wrappedTools) {
    toolMap.set(entry.name, entry.tool);
  }

  return {
    listTools: async () => ({
      tools: wrappedTools.map(({ name, description, inputSchema }) => ({
        name,
        description,
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

function snapshotMcpPluginTools(tools: readonly AnyAgentTool[]): McpPluginToolSnapshot[] {
  const snapshots: McpPluginToolSnapshot[] = [];
  for (const entry of readMcpPluginToolEntries(tools)) {
    if (!entry.readable) {
      warnSkippedMcpPluginTool(entry.toolName, entry.violations);
      continue;
    }
    const snapshot = snapshotMcpPluginTool(entry.tool, entry.toolIndex);
    if (!snapshot.readable) {
      warnSkippedMcpPluginTool(snapshot.toolName, snapshot.violations);
      continue;
    }
    snapshots.push(snapshot);
  }
  return snapshots;
}

function readMcpPluginToolEntries(tools: readonly AnyAgentTool[]): McpPluginToolEntryRead[] {
  let length: number;
  try {
    length = tools.length;
  } catch {
    return [unreadableMcpPluginToolEntry(0)];
  }
  const entries: McpPluginToolEntryRead[] = [];
  for (let toolIndex = 0; toolIndex < length; toolIndex += 1) {
    try {
      const tool = tools[toolIndex];
      if (!tool) {
        entries.push(unreadableMcpPluginToolEntry(toolIndex));
        continue;
      }
      entries.push({ readable: true, tool, toolIndex });
    } catch {
      entries.push(unreadableMcpPluginToolEntry(toolIndex));
    }
  }
  return entries;
}

function unreadableMcpPluginToolEntry(toolIndex: number): McpPluginToolEntryRead {
  const toolName = `tool[${toolIndex}]`;
  return {
    readable: false,
    toolName,
    violations: [`${toolName} is unreadable`],
  };
}

function snapshotMcpPluginTool(
  tool: AnyAgentTool,
  toolIndex: number,
):
  | ({ readable: true } & McpPluginToolSnapshot)
  | { readable: false; toolName: string; violations: readonly string[] } {
  const fallbackName = `tool[${toolIndex}]`;
  const nameRead = readMcpPluginToolField(tool, "name");
  const hasValidName =
    nameRead.readable && typeof nameRead.value === "string" && nameRead.value.length > 0;
  const name = hasValidName && typeof nameRead.value === "string" ? nameRead.value : fallbackName;
  const violations: string[] = [];
  if (!nameRead.readable) {
    violations.push(`${name}.name is unreadable`);
  } else if (!hasValidName) {
    violations.push(`${name}.name must be a non-empty string`);
  }

  const descriptionRead = readMcpPluginToolField(tool, "description");
  if (!descriptionRead.readable) {
    violations.push(`${name}.description is unreadable`);
  }

  const parametersRead = readMcpPluginToolField(tool, "parameters");
  if (!parametersRead.readable) {
    violations.push(`${name}.parameters is unreadable`);
  }

  if (!descriptionRead.readable || !parametersRead.readable || violations.length > 0) {
    return { readable: false, toolName: name, violations };
  }
  const parameters = parametersRead.value ?? { type: "object", properties: {} };
  const projection = projectRuntimeToolInputSchema(parameters, `${name}.parameters`);
  if (projection.violations.length > 0) {
    return { readable: false, toolName: name, violations: projection.violations };
  }
  return {
    readable: true,
    tool,
    name,
    description: typeof descriptionRead.value === "string" ? descriptionRead.value : "",
    inputSchema: normalizeMcpInputSchema(projection.schema as Record<string, unknown>),
  };
}

function normalizeMcpInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return schema.type === undefined ? { ...schema, type: "object" } : schema;
}

function readMcpPluginToolField(
  tool: AnyAgentTool,
  field: "description" | "name" | "parameters",
): { readable: true; value: unknown } | { readable: false } {
  try {
    return { readable: true, value: (tool as unknown as Record<string, unknown>)[field] };
  } catch {
    return { readable: false };
  }
}

function warnSkippedMcpPluginTool(toolName: string, violations: readonly string[]): void {
  const safeToolName = sanitizeForLog(toolName);
  const safeViolations = violations.map((violation) => sanitizeForLog(violation)).join(", ");
  process.stderr.write(
    `plugin-tools-serve: skipped unsupported plugin tool ${safeToolName}: ${safeViolations}\n`,
  );
}
