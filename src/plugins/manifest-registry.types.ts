import type {
  PluginBundleFormat,
  PluginConfigUiHint,
  PluginDiagnostic,
  PluginFormat,
  PluginManifest,
  PluginManifestChannelCommandDefaults,
  PluginManifestChannelConfig,
} from "./manifest-types.js";
import type {
  OpenClawPackageManifest,
  PluginPackageChannel,
  PluginPackageInstall,
} from "./package-manifest.types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginTrust } from "./plugin-trust.js";
import type { PluginDependencySpecMap } from "./status-dependencies-core.js";

export type PluginManifestContractListKey =
  | "speechProviders"
  | "externalAuthProviders"
  | "embeddingProviders"
  | "mediaUnderstandingProviders"
  | "transcriptSourceProviders"
  | "documentExtractors"
  | "realtimeVoiceProviders"
  | "realtimeTranscriptionProviders"
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders"
  | "webContentExtractors"
  | "webFetchProviders"
  | "webSearchProviders"
  | "workerProviders"
  | "usageProviders"
  | "migrationProviders"
  | "gatewayMethodDispatch";

type PluginManifestRecordStatic = Omit<
  PluginManifest,
  | "capabilityCatalogEntry"
  | "channels"
  | "cliBackends"
  | "configSchema"
  | "enabledByDefaultOnPlatforms"
  | "providerCatalogEntry"
  | "providers"
  | "requiresPlugins"
  | "skills"
  | "uiHints"
>;

export type PluginManifestRecord = PluginManifestRecordStatic & {
  /** Process-local source selection, never persisted in the installed index. */
  sourcePreferred?: true;
  iconPath?: string;
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  enabledByDefaultOnPlatforms?: string[];
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  bundleCapabilities?: string[];
  channels: string[];
  providers: string[];
  providerDiscoverySource?: string;
  /** Undefined is undeclared; null retains a rejected declaration without enabling full-entry fallback. */
  capabilityCatalogSource?: string | null;
  cliBackends: string[];
  packageManifest?: OpenClawPackageManifest;
  packageDependencies?: PluginDependencySpecMap;
  packageOptionalDependencies?: PluginDependencySpecMap;
  packageChannel?: PluginPackageChannel;
  packageInstall?: PluginPackageInstall;
  trustedOfficialInstall?: boolean;
  trust?: PluginTrust;
  skills: string[];
  settingsFiles?: string[];
  hooks: string[];
  origin: PluginOrigin;
  workspaceDir?: string;
  rootDir: string;
  source: string;
  setupSource?: string;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
  configUiHints?: Record<string, PluginConfigUiHint>;
  channelCatalogMeta?: {
    id: string;
    label?: string;
    blurb?: string;
    preferOver?: readonly string[];
    commands?: PluginManifestChannelCommandDefaults;
  };
};

export type PluginManifestRegistry = {
  plugins: PluginManifestRecord[];
  diagnostics: PluginDiagnostic[];
};

export type BundledChannelConfigCollector = (params: {
  pluginDir: string;
  manifest: PluginManifest;
  packageManifest?: OpenClawPackageManifest;
}) => Record<string, PluginManifestChannelConfig> | undefined;
