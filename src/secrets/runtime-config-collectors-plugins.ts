import type { OpenClawConfig } from "../config/config.js";
import { normalizePluginsConfig, resolveEnableState } from "../plugins/config-state.js";
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
 *
 * When `loadablePluginIds` is provided, entries whose ID is not in the set
 * are treated as inactive (stale config entries for plugins that are no longer
 * installed). This prevents resolution failures for SecretRefs belonging to
 * non-loadable plugins from blocking gateway startup.
 */
export function collectPluginConfigAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  loadablePluginIds?: ReadonlySet<string>;
}): void {
  const entries = params.config.plugins?.entries;
  if (!isRecord(entries)) {
    return;
  }

  // Use the same enable-state logic the plugin loader uses so that entries
  // disabled by denylist, allowlist, or other config-level rules are treated
  // as inactive. We pass origin "config" because these entries are defined in
  // the config file and that is the most accurate origin we can infer here.
  const normalizedConfig = normalizePluginsConfig(params.config.plugins);

  for (const [pluginId, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) {
      continue;
    }
    const pluginConfig = entry.config;
    if (!isRecord(pluginConfig)) {
      continue;
    }

    // Skip stale/non-loadable entries when the caller supplies a known-plugin set.
    if (params.loadablePluginIds && !params.loadablePluginIds.has(pluginId)) {
      collectMcpServerEnvAssignments({
        pluginId,
        pluginConfig,
        active: false,
        inactiveReason: "plugin is not loadable (stale config entry).",
        defaults: params.defaults,
        context: params.context,
      });
      continue;
    }

    const enableState = resolveEnableState(pluginId, "config", normalizedConfig);
    collectMcpServerEnvAssignments({
      pluginId,
      pluginConfig,
      active: enableState.enabled,
      inactiveReason: enableState.reason ?? "plugin is disabled.",
      defaults: params.defaults,
      context: params.context,
    });
  }
}

function collectMcpServerEnvAssignments(params: {
  pluginId: string;
  pluginConfig: Record<string, unknown>;
  active: boolean;
  inactiveReason: string;
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
        active: params.active,
        inactiveReason: `plugin "${params.pluginId}": ${params.inactiveReason}`,
        apply: (value) => {
          env[envKey] = value;
        },
      });
    }
  }
}
