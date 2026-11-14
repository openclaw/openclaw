/**
 * Agent tool stub helpers for tests.
 *
 * Builds no-op tool inventory entries when tests only need schema and naming shape.
 */
import { Type } from "typebox";
import { setPluginToolMeta } from "../../plugins/tool-metadata.js";
import type { ClientToolDefinition } from "../command/shared-types.js";
import type { AgentTool, AgentToolResult } from "../runtime/index.js";

/** Creates a no-op tool with an empty object schema. */
export function createStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({}) as AgentToolResult<unknown>,
  };
}

/** Creates a no-op bundle MCP tool named `<server>__<toolName>`, as the MCP runtime does. */
export function createMcpStubTool(server: string, toolName: string, description = ""): AgentTool {
  const tool = { ...createStubTool(`${server}__${toolName}`), description };
  setPluginToolMeta(tool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: { serverName: server, safeServerName: server, toolName, operation: "tool" },
  });
  return tool;
}

export const createClientToolDefinition = (name: string): ClientToolDefinition => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: {} } },
});
