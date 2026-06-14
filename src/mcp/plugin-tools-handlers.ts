// Plugin MCP tool handlers route plugin tool calls through the active runtime.
import {
  isToolWrappedWithBeforeToolCallHook,
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agents/agent-tools.before-tool-call.js";
import { copyChannelAgentToolMeta } from "../agents/channel-tools.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { formatErrorMessage } from "../infra/errors.js";
import { copyPluginToolMeta } from "../plugins/tool-metadata.js";
import { coerceChatContentText } from "../shared/chat-content.js";

type CallPluginToolParams = {
  name: string;
  arguments?: unknown;
};

function resolveJsonSchemaForTool(tool: AnyAgentTool): Record<string, unknown> {
  const params = tool.parameters;
  if (params && typeof params === "object" && "type" in params) {
    return params as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
}

function snapshotMcpPluginTool(tool: AnyAgentTool): AnyAgentTool | undefined {
  let name: unknown;
  let description: unknown;
  let parameters: unknown;
  let execute: unknown;
  try {
    name = tool.name;
    description = tool.description;
    parameters = tool.parameters;
    execute = tool.execute;
  } catch {
    return undefined;
  }
  if (typeof name !== "string" || !name.trim() || typeof execute !== "function") {
    return undefined;
  }

  let prototype: object | null;
  try {
    prototype = Reflect.getPrototypeOf(tool);
  } catch {
    return undefined;
  }
  const descriptors = copyReadableMcpPluginToolDescriptors(tool);
  if (!descriptors) {
    return undefined;
  }
  descriptors.name = {
    configurable: true,
    enumerable: true,
    value: name.trim(),
    writable: true,
  };
  descriptors.description = {
    configurable: true,
    enumerable: true,
    value: typeof description === "string" ? description : "",
    writable: true,
  };
  descriptors.parameters = {
    configurable: true,
    enumerable: true,
    value: parameters,
    writable: true,
  };
  descriptors.execute = {
    configurable: true,
    enumerable: true,
    value: (...args: Parameters<AnyAgentTool["execute"]>) =>
      Reflect.apply(execute, tool, args) as ReturnType<AnyAgentTool["execute"]>,
    writable: true,
  };

  const snapshot = Object.create(prototype) as AnyAgentTool;
  Object.defineProperties(snapshot, descriptors);
  copyPluginToolMeta(tool, snapshot);
  copyChannelAgentToolMeta(tool as never, snapshot as never);
  return snapshot;
}

function copyReadableMcpPluginToolDescriptors(
  tool: AnyAgentTool,
): PropertyDescriptorMap | undefined {
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(tool);
  } catch {
    return undefined;
  }

  const descriptors: PropertyDescriptorMap = {};
  for (const key of keys) {
    if (key === "name" || key === "description" || key === "parameters" || key === "execute") {
      continue;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(tool, key);
    } catch {
      return undefined;
    }
    if (!descriptor) {
      continue;
    }
    if ("value" in descriptor) {
      descriptors[key] = {
        configurable: true,
        enumerable: descriptor.enumerable,
        value: descriptor.value,
        writable: true,
      };
      continue;
    }
    try {
      descriptors[key] = {
        configurable: true,
        enumerable: descriptor.enumerable,
        value: Reflect.get(tool, key, tool),
        writable: true,
      };
    } catch {
      continue;
    }
  }
  return descriptors;
}

function wrapPluginToolForMcp(tool: AnyAgentTool): AnyAgentTool | undefined {
  try {
    if (isToolWrappedWithBeforeToolCallHook(tool)) {
      return rewrapToolWithBeforeToolCallHook(tool, undefined, { approvalMode: "report" });
    }
  } catch {
    return undefined;
  }
  const snapshot = snapshotMcpPluginTool(tool);
  if (!snapshot) {
    return undefined;
  }
  return wrapToolWithBeforeToolCallHook(snapshot, undefined, { approvalMode: "report" });
}

export function createPluginToolsMcpHandlers(tools: AnyAgentTool[]) {
  const wrappedTools = tools.flatMap((tool) => {
    const wrapped = wrapPluginToolForMcp(tool);
    return wrapped ? [wrapped] : [];
  });
  const toolMap = new Map<string, AnyAgentTool>();
  for (const tool of wrappedTools) {
    toolMap.set(tool.name, tool);
  }

  return {
    listTools: async () => ({
      tools: wrappedTools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: resolveJsonSchemaForTool(tool),
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
