import { vi } from "vitest";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  TOOL_SEARCH_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_CALL_RAW_TOOL_NAME,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

export function fakeTool(name: string, description: string): AnyAgentTool {
  return {
    name,
    label: name,
    description,
    parameters: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
    },
    execute: vi.fn(async (_toolCallId, input) => jsonResult({ name, input })),
  };
}

export function structuredControlStubs(): AnyAgentTool[] {
  return [
    fakeTool(TOOL_SEARCH_RAW_TOOL_NAME, "search"),
    fakeTool(TOOL_DESCRIBE_RAW_TOOL_NAME, "describe"),
    fakeTool(TOOL_CALL_RAW_TOOL_NAME, "call"),
  ];
}

export function pluginTool(
  name: string,
  description: string,
  pluginId = "fake-catalog",
): AnyAgentTool {
  const tool = fakeTool(name, description);
  setPluginToolMeta(tool, {
    pluginId,
    optional: true,
  });
  return tool;
}

export function mcpPluginTool(
  name: string,
  description: string,
  pluginId = "fake-catalog",
): AnyAgentTool {
  const tool = fakeTool(name, description);
  setPluginToolMeta(tool, {
    pluginId,
    optional: true,
    mcp: {
      serverName: "remote-demo",
      safeServerName: "remoteDemo",
      toolName: "echo",
      operation: "tool",
    },
  });
  return tool;
}
