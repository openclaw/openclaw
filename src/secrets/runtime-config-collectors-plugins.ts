import { resolveConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectPluginConfigContractMatches,
  resolvePluginConfigContractsById,
} from "../plugins/config-contracts.js";
import { normalizePluginsConfig, resolveEnableState } from "../plugins/config-state.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { formatConcreteConfigPath } from "../shared/dot-path.js";
import {
  collectCanonicalSecretInputAssignment as collectSecretInputAssignment,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

/**
 * Walk manifest-declared plugin config SecretRef surfaces and collect
 * assignments for runtime materialization. Plugin-owned metadata controls which
 * config paths support SecretRefs and whether bundled plugins stay inactive on
 * that surface until explicitly enabled.
 *
 * When `loadablePluginOrigins` is provided, entries whose ID is not in the map
 * are treated as inactive (stale config entries for plugins that are no longer
 * installed). This prevents resolution failures for SecretRefs belonging to
 * non-loadable plugins from blocking startup or preflight validation.
 */
export function collectPluginConfigAssignments(params: {
  /** Mutable config snapshot whose plugin config values will receive resolved secrets. */
  config: OpenClawConfig;
  /** Defaults from the source config, used while matching manifest-declared SecretInput paths. */
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  /** Optional installed plugin roots; missing IDs are treated as stale inactive config. */
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): void {
  const entries = params.config.plugins?.entries;
  if (!isRecord(entries)) {
    return;
  }

  const normalizedConfig = normalizePluginsConfig(params.config.plugins);
  const manifestRegistry =
    params.context.manifestRegistry ??
    resolveConfigWidePluginManifestRegistry({
      config: params.config,
      env: params.context.env,
    });
  const bundledLoadablePluginIds = params.context.manifestRegistry
    ? []
    : [...(params.loadablePluginOrigins?.entries() ?? [])]
        .filter(([, origin]) => origin === "bundled")
        .map(([pluginId]) => pluginId);
  const pluginContracts = resolvePluginConfigContractsById({
    config: params.config,
    env: params.context.env,
    fallbackToBundledMetadata: true,
    fallbackToBundledMetadataForResolvedBundled: !params.context.manifestRegistry,
    fallbackBundledPluginIds: bundledLoadablePluginIds,
    pluginIds: Object.keys(entries),
    manifestRegistry,
  });

  for (const [pluginId, entry] of Object.entries(entries)) {
    const metadata = pluginContracts.get(pluginId);
    if (!metadata?.configContracts.secretInputs?.paths.length) {
      continue;
    }
    const secretInputs = metadata.configContracts.secretInputs;
    if (!isRecord(entry)) {
      continue;
    }
    const pluginConfig = entry.config;
    if (!isRecord(pluginConfig)) {
      continue;
    }

    const pluginOrigin = params.loadablePluginOrigins?.get(pluginId);
    const resolvedOrigin = pluginOrigin ?? metadata.origin;
    const enableState =
      params.loadablePluginOrigins && !pluginOrigin
        ? { enabled: false, reason: "plugin is not loadable (stale config entry)." }
        : resolveEnableState(
            pluginId,
            resolvedOrigin,
            normalizedConfig,
            resolvedOrigin === "bundled" ? secretInputs.bundledDefaultEnabled : undefined,
          );
    const inactiveReason = enableState.reason ?? "plugin is disabled.";
    const pluginConfigPath = formatConcreteConfigPath(["plugins", "entries", pluginId, "config"]);
    const seenPaths = new Set<string>();
    for (const secretPath of secretInputs.paths) {
      for (const match of collectPluginConfigContractMatches({
        root: pluginConfig,
        pathPattern: secretPath.path,
      })) {
        const relativePath = match.path.startsWith("[") ? match.path : `.${match.path}`;
        const fullPath = `${pluginConfigPath}${relativePath}`;
        if (seenPaths.has(fullPath)) {
          continue;
        }
        seenPaths.add(fullPath);
        // Routes may retain an unchanged secret during a transient outage.
        // Tool capabilities become unavailable so a stale API key cannot remain active.
        const ownerContract = secretPath.ownerKind === "route" ? pluginConfig : undefined;

        // SecretInput allows both explicit objects and inline env-template refs
        // like `${MCP_API_KEY}`. Non-ref strings remain untouched because
        // collectSecretInputAssignment ignores them.
        collectSecretInputAssignment({
          value: match.value,
          path: fullPath,
          expected: secretPath.expected ?? "string",
          defaults: params.defaults,
          context: params.context,
          active: enableState.enabled,
          inactiveReason: `plugin "${pluginId}": ${inactiveReason}`,
          ...(secretPath.ownerKind
            ? {
                owner: {
                  ownerKind: secretPath.ownerKind,
                  ownerId: fullPath,
                  requiredForGateway: false,
                  disposition: "isolate" as const,
                  ...(ownerContract ? { contract: ownerContract } : {}),
                },
              }
            : {}),
          apply: (value) => {
            Reflect.set(match.parent, match.key, value);
          },
        });
      }
    }
  }
}
