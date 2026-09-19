import type { BundledStaticCatalogState } from "../agents/embedded-agent-runner/model.static-catalog.types.js";
import type { BundledChannelCatalogEntry } from "../channels/bundled-channel-catalog.types.js";
import type { ManifestChannelPlugin } from "../channels/plugins/manifest-channel-plugin.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginCandidate, PluginDiscoveryResult } from "./discovery.types.js";
import type {
  InstalledPluginIndex,
  InstalledPluginIndexFacts,
} from "./installed-plugin-index-types.js";
import type { ManifestModelSuppressionResolver } from "./manifest-model-suppression.types.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import type { BundledProviderPolicySurface } from "./provider-policy-surface.types.js";

export type ProviderPolicyOwnerIndex = {
  bundled: Map<string, PluginManifestRecord>;
  trusted: Map<string, PluginManifestRecord[]>;
};

type CurrentPluginMetadataCacheState = {
  snapshot: PluginMetadataSnapshot | undefined;
  owner: "gateway" | "operation";
  configFingerprint: string | undefined;
  envFingerprint: string | undefined;
  defaultDiscoveryCompatible: boolean;
  compatiblePolicyHashes: readonly string[] | undefined;
  compatibleConfigFingerprints: readonly string[] | undefined;
  revision: symbol;
  configIdentities: WeakSet<OpenClawConfig>;
};

export type PluginCacheMetadata = {
  metadata: {
    bundledPluginsDir?: {
      moduleUrl: string;
      disabled: boolean;
      resolvedOverride: string | undefined;
      trustOverride: boolean;
      argv1: string | undefined;
      execPath: string;
      cwd: string | undefined;
      value: string | undefined;
    };
    bundledProviderPolicySurfaces: Map<
      string,
      {
        registry: object | null;
        version: number | undefined;
        selection: PluginCacheMetadata["metadata"]["bundledPluginsDir"];
        read: () => BundledProviderPolicySurface | null;
      }
    >;
    bundledDiscoveryMode?: { value: "compat" | "allowlist" | undefined };
    current: CurrentPluginMetadataCacheState;
    snapshots: Map<string, PluginMetadataSnapshot>;
    discovery: Map<string, PluginDiscoveryResult>;
    sharedDiscovery: Map<
      string,
      {
        candidates: ReadonlyArray<{ candidate: PluginCandidate; usesWorkspace: boolean }>;
        diagnostics: PluginDiscoveryResult["diagnostics"];
      }
    >;
    discoveryMountPoints?: ReadonlySet<string>;
    projections: WeakMap<PluginMetadataSnapshot, Map<string, PluginMetadataSnapshot>>;
    projectionSources: WeakMap<PluginMetadataSnapshot, PluginMetadataSnapshot>;
    completions: WeakMap<PluginMetadataSnapshot, PluginMetadataSnapshot>;
    indexFacts: WeakMap<InstalledPluginIndex, InstalledPluginIndexFacts>;
    providerPolicyOwners: WeakMap<object, ProviderPolicyOwnerIndex>;
    channelAdapters: WeakMap<PluginManifestRecord, Map<string, ManifestChannelPlugin | undefined>>;
    bundledChannelCatalogs: Map<string, BundledChannelCatalogEntry[]>;
    staticCatalogStates: WeakMap<object, WeakMap<OpenClawConfig, BundledStaticCatalogState>>;
    modelSuppressionResolvers: WeakMap<
      PluginMetadataSnapshot,
      {
        unconfigured?: ManifestModelSuppressionResolver;
        byConfig: WeakMap<OpenClawConfig, ManifestModelSuppressionResolver>;
      }
    >;
  };
};
