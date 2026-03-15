import type { OpenClawConfig } from "../config/config.js";
import {
  collectSecretInputAssignment,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

/**
 * Walk plugin config entries and collect SecretRef assignments for MCP server
 * env vars. Without this, SecretRefs in paths like
 * `plugins.entries.acpx.config.mcpServers.*.env.*` are never resolved and
 * remain as raw objects at runtime.
 */
export function collectPluginConfigAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const entries = params.config.plugins?.entries;
  if (!isRecord(entries)) {
    return;
  }

  for (const [pluginId, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) {
      continue;
    }
    const pluginConfig = entry.config;
    if (!isRecord(pluginConfig)) {
      continue;
    }
    collectMcpServerEnvAssignments({
      pluginId,
      pluginConfig,
      defaults: params.defaults,
      context: params.context,
    });
  }
}

function collectMcpServerEnvAssignments(params: {
  pluginId: string;
  pluginConfig: Record<string, unknown>;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const mcpServers = params.pluginConfig.mcpServers;
  if (!isRecord(mcpServers)) {
    return;
  }

  for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
    if (!isRecord(serverConfig)) {
      continue;
    }
    const env = serverConfig.env;
    if (!isRecord(env)) {
      continue;
    }

    for (const [envKey, envValue] of Object.entries(env)) {
      collectSecretInputAssignment({
        value: envValue,
        path: `plugins.entries.${params.pluginId}.config.mcpServers.${serverName}.env.${envKey}`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        apply: (value) => {
          env[envKey] = value;
        },
      });
    }
  }
}
