import type { OpenClawConfig } from "../config/config.js";
import { normalizePluginsConfig, resolveEnableState } from "../plugins/config-state.js";
import type { PluginOrigin } from "../plugins/types.js";
import {
  collectSecretInputAssignment,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

const ACPX_PLUGIN_ID = "acpx";
const ACPX_ENABLED_BY_DEFAULT = false;

/**
 * Walk plugin config entries and collect SecretRef assignments for MCP server
 * env vars. Without this, SecretRefs in paths like
 * `plugins.entries.acpx.config.mcpServers.*.env.*` are never resolved and
 * remain as raw objects at runtime.
 *
 * This surface is intentionally scoped to ACPX. Third-party plugins may define
 * their own `mcpServers`-shaped config, but that is not a documented SecretRef
 * surface and should not be rewritten here.
 *
 * When `loadablePluginOrigins` is provided, entries whose ID is not in the map
 * are treated as inactive (stale config entries for plugins that are no longer
 * installed). This prevents resolution failures for SecretRefs belonging to
 * non-loadable plugins from blocking startup or preflight validation.
 */
export function collectPluginConfigAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): void {
  const entries = params.config.plugins?.entries;
  if (!isRecord(entries)) {
    return;
  }

  const normalizedConfig = normalizePluginsConfig(params.config.plugins);

  for (const [pluginId, entry] of Object.entries(entries)) {
    if (pluginId !== ACPX_PLUGIN_ID) {
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const pluginConfig = entry.config;
    if (!isRecord(pluginConfig)) {
      continue;
    }

    const pluginOrigin = params.loadablePluginOrigins?.get(pluginId);
    if (params.loadablePluginOrigins && !pluginOrigin) {
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

    const enableState = resolveEnableState(
      pluginId,
      pluginOrigin ?? "config",
      normalizedConfig,
      pluginId === ACPX_PLUGIN_ID && pluginOrigin === "bundled"
        ? ACPX_ENABLED_BY_DEFAULT
        : undefined,
    );
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
      // SecretInput allows both explicit objects and inline env-template refs
      // like `${MCP_API_KEY}`. Non-ref strings remain untouched because
      // collectSecretInputAssignment ignores them.
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
