import type { AnyAgentTool } from "../agents/tools/common.js";

/** MCP bridge metadata attached to plugin tools surfaced through agent tool lists. */
export type PluginToolMcpMeta = {
  serverName: string;
  safeServerName: string;
  toolName: string;
  operation: "tool" | "resources_list" | "resources_read" | "prompts_list" | "prompts_get";
};

/** Runtime metadata used to trace an agent tool back to its owning plugin registration. */
export type PluginToolMeta = {
  pluginId: string;
  optional: boolean;
  trustedLocalMedia?: boolean;
  mcp?: PluginToolMcpMeta;
};

const pluginToolMeta = new WeakMap<AnyAgentTool, PluginToolMeta>();

/** Attaches plugin ownership metadata to a concrete agent tool instance. */
export function setPluginToolMeta(tool: AnyAgentTool, meta: PluginToolMeta): void {
  pluginToolMeta.set(tool, meta);
}

/** Reads plugin ownership metadata for a concrete agent tool instance. */
export function getPluginToolMeta(tool: AnyAgentTool): PluginToolMeta | undefined {
  return pluginToolMeta.get(tool);
}

/** Copies plugin ownership metadata when wrappers replace a tool object. */
export function copyPluginToolMeta(source: AnyAgentTool, target: AnyAgentTool): void {
  const meta = pluginToolMeta.get(source);
  if (meta) {
    pluginToolMeta.set(target, meta);
  }
}
