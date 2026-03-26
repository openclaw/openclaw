import type { OpenClawConfig } from "../config/config.js";
import { isRecord } from "../utils.js";
import type { BundleMcpServerConfig } from "./bundle-mcp.js";
import type { PluginRegistry } from "./registry.js";
import { getActivePluginRegistry } from "./runtime.js";

export function resolveManagedMcpServers(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  registry?: PluginRegistry | null;
}): Record<string, BundleMcpServerConfig> {
  const registry = params.registry ?? getActivePluginRegistry();
  if (!registry) {
    return {};
  }

  const config = params.cfg ?? ({} as OpenClawConfig);
  const servers: Record<string, BundleMcpServerConfig> = {};

  for (const entry of registry.managedMcpServers) {
    const rawConfig =
      typeof entry.server.config === "function"
        ? entry.server.config({
            config,
            workspaceDir: params.workspaceDir,
          })
        : entry.server.config;
    if (!isRecord(rawConfig)) {
      continue;
    }
    servers[entry.server.name] = { ...rawConfig };
  }

  return servers;
}
