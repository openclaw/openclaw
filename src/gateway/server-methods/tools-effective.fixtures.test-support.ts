import { vi } from "vitest";
import type { EffectiveToolInventoryResult as ToolsEffectivePayload } from "../../agents/tools-effective-inventory.types.js";
import { setPluginToolMeta } from "../../plugins/tool-metadata.js";

export function makeMcpTool(
  params: Record<string, unknown> = { type: "object", properties: {} },
  identity = {
    name: "reproProbe__probe_tool",
    label: "Probe Tool",
    toolName: "probe_tool",
    serverName: "reproProbe",
    deniedBySession: false,
  },
) {
  const tool = {
    name: identity.name,
    label: identity.label,
    description: "Probe from MCP",
    parameters: params,
    execute: vi.fn(),
  };
  setPluginToolMeta(tool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: identity.serverName,
      safeServerName: identity.serverName,
      toolName: identity.toolName,
      operation: "tool",
      ...(identity.deniedBySession ? { deniedBySession: true } : {}),
    },
  });
  return tool;
}

const coreTool = {
  id: "exec",
  label: "Exec",
  description: "Run shell commands",
  rawDescription: "Run shell commands",
  source: "core" as const,
};

export function makeCoreInventory(tool: Partial<typeof coreTool> = {}): ToolsEffectivePayload {
  return {
    agentId: "main",
    profile: "coding",
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [{ ...coreTool, ...tool }],
      },
    ],
  };
}
