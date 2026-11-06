import type { PluginDeclaredSurface } from "../../packages/gateway-protocol/src/schema/plugins.js";

export function createPluginDeclaredSurface(
  overrides: Partial<PluginDeclaredSurface> = {},
): PluginDeclaredSurface {
  return {
    channels: [],
    providers: [],
    tools: [],
    contracts: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
    ...overrides,
  };
}
