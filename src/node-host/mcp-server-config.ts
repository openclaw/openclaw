import type { McpServerConfig } from "../config/types.mcp.js";

export function listEnabledNodeHostMcpServers(
  servers: Record<string, McpServerConfig> | undefined,
): ReadonlyArray<readonly [string, McpServerConfig]> {
  return Object.entries(servers ?? {})
    .filter(
      ([serverName, config]) =>
        serverName.length > 0 && serverName === serverName.trim() && config.enabled !== false,
    )
    .toSorted(([left], [right]) => left.localeCompare(right));
}
