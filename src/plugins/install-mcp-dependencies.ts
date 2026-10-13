import type { OpenClawConfig } from "../config/types.openclaw.js";
import { installDeclaredTool } from "../skills/lifecycle/install.js";
import type { PluginManifestMcpServer } from "./manifest-types.js";
import type { PluginInstallLogger } from "./install-types.js";
import type { SkillInstallSpec } from "../skills/types.js";

/** Returns whether an install spec is applicable to the current host OS platform. */
export function isInstallSpecSupportedOnPlatform(spec: SkillInstallSpec, platform = process.platform): boolean {
  const osList = spec.os ?? [];
  return osList.length === 0 || osList.includes(platform);
}

/** Runs the explicit plugin-install-time recipes required by static MCP servers. */
export async function installPluginMcpDependencies(params: {
  pluginId: string;
  mcpServers?: Record<string, PluginManifestMcpServer>;
  config?: OpenClawConfig;
  timeoutMs: number;
  logger: PluginInstallLogger;
  signal?: AbortSignal;
  assertOwned?: () => void;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const [serverName, server] of Object.entries(params.mcpServers ?? {})) {
    for (const spec of server.install ?? []) {
      params.signal?.throwIfAborted();
      params.assertOwned?.();
      if (!isInstallSpecSupportedOnPlatform(spec)) {
        continue;
      }
      params.logger.info?.(`Installing MCP dependency for ${params.pluginId}/${serverName}: ${spec.label ?? spec.kind}…`);
      const result = await installDeclaredTool({ spec, config: params.config, timeoutMs: params.timeoutMs });
      params.signal?.throwIfAborted();
      params.assertOwned?.();
      if (!result.ok) {
        return { ok: false, error: `Failed to install MCP dependency for ${params.pluginId}/${serverName}: ${result.message}` };
      }
    }
  }
  return { ok: true };
}
