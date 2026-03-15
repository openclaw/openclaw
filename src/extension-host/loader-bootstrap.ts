import type { OpenClawConfig } from "../config/config.js";
import type { NormalizedPluginsConfig } from "../plugins/config-state.js";
import { discoverOpenClawPlugins, type PluginCandidate } from "../plugins/discovery.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
  type PluginManifestRegistry,
} from "../plugins/manifest-registry.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginLogger } from "../plugins/types.js";
import { resolveExtensionHostDiscoveryPolicy } from "./loader-discovery-policy.js";
import {
  buildExtensionHostProvenanceIndex,
  compareExtensionHostDuplicateCandidateOrder,
  pushExtensionHostDiagnostics,
} from "./loader-policy.js";
import type { ExtensionHostProvenanceIndex } from "./loader-provenance.js";

export function bootstrapExtensionHostPluginLoad(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
  cacheKey: string;
  normalizedConfig: NormalizedPluginsConfig;
  warningCache: Set<string>;
  logger: PluginLogger;
  registry: PluginRegistry;
  discoverPlugins?: typeof discoverOpenClawPlugins;
  loadManifestRegistry?: typeof loadPluginManifestRegistry;
  pushDiagnostics?: typeof pushExtensionHostDiagnostics;
  resolveDiscoveryPolicy?: typeof resolveExtensionHostDiscoveryPolicy;
  buildProvenanceIndex?: typeof buildExtensionHostProvenanceIndex;
  compareDuplicateCandidateOrder?: typeof compareExtensionHostDuplicateCandidateOrder;
}): {
  manifestByRoot: Map<string, PluginManifestRecord>;
  orderedCandidates: PluginCandidate[];
  provenance: ExtensionHostProvenanceIndex;
  manifestRegistry: PluginManifestRegistry;
} {
  const discoverPlugins = params.discoverPlugins ?? discoverOpenClawPlugins;
  const loadManifestRegistry = params.loadManifestRegistry ?? loadPluginManifestRegistry;
  const pushDiagnostics = params.pushDiagnostics ?? pushExtensionHostDiagnostics;
  const resolveDiscoveryPolicy =
    params.resolveDiscoveryPolicy ?? resolveExtensionHostDiscoveryPolicy;
  const buildProvenanceIndex = params.buildProvenanceIndex ?? buildExtensionHostProvenanceIndex;
  const compareDuplicateCandidateOrder =
    params.compareDuplicateCandidateOrder ?? compareExtensionHostDuplicateCandidateOrder;

  const discovery = discoverPlugins({
    workspaceDir: params.workspaceDir,
    extraPaths: params.normalizedConfig.loadPaths,
    cache: params.cache,
    env: params.env,
  });
  const manifestRegistry = loadManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    cache: params.cache,
    env: params.env,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });

  pushDiagnostics(params.registry.diagnostics, manifestRegistry.diagnostics);

  const discoveryPolicy = resolveDiscoveryPolicy({
    pluginsEnabled: params.normalizedConfig.enabled,
    allow: params.normalizedConfig.allow,
    warningCacheKey: params.cacheKey,
    warningCache: params.warningCache,
    discoverablePlugins: manifestRegistry.plugins.map((plugin) => ({
      id: plugin.id,
      source: plugin.source,
      origin: plugin.origin,
    })),
  });
  for (const warning of discoveryPolicy.warningMessages) {
    params.logger.warn(warning);
  }

  const provenance = buildProvenanceIndex({
    config: params.config,
    normalizedLoadPaths: params.normalizedConfig.loadPaths,
    env: params.env,
  });

  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );
  const orderedCandidates = [...discovery.candidates].toSorted((left, right) => {
    return compareDuplicateCandidateOrder({
      left,
      right,
      manifestByRoot,
      provenance,
      env: params.env,
    });
  });

  return {
    manifestByRoot,
    orderedCandidates,
    provenance,
    manifestRegistry,
  };
}
