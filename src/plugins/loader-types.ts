import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import type { PluginCapabilityCatalogHostContext } from "./capability-catalog-context.types.js";
import type { PluginCapabilityCatalog } from "./capability-catalog.types.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginModuleLoaderRecovery } from "./plugin-instance.types.js";
import type { PluginRuntimeArtifact } from "./plugin-runtime-artifact-selection.js";
import type { PluginRecord, PluginRegistry, PluginRegistryParams } from "./registry-types.js";
import type { CreatePluginRuntimeOptions } from "./runtime/types.js";
import type { PluginSdkResolutionPreference } from "./sdk-alias.js";
import type { PluginLogger } from "./types.js";

export type PluginRuntimeSubagentMode = "default" | "explicit" | "gateway-bindable";
export type ChannelPluginLoadIntent = "full" | "setup";

/** Host-owned recovery of one previously admitted runtime, never current package discovery. */
export type PluginRuntimeRecovery = {
  module: PluginModuleLoaderRecovery;
  runtimeEntry: PluginRuntimeArtifact;
  setupEntry?: PluginRuntimeArtifact;
};

/** Inputs shared by runtime, snapshot, and CLI-metadata plugin loading. */
export type PluginLoadOptions = {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  autoEnabledReasons?: Readonly<Record<string, string[]>>;
  workspaceDir?: string;
  installRecords?: Record<string, PluginInstallRecord>;
  /** Resolve plugin roots and load paths against an explicit environment. */
  env?: NodeJS.ProcessEnv;
  /** Apply the config IO env-substitution pass to direct raw-config callers. */
  resolveRawConfigEnvVars?: boolean;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  coreGatewayMethodNames?: readonly string[];
  /** Registry-construction fact supplied by the process composition root. */
  allowProcessHomeSessionCatalogs?: boolean;
  hostServices?: PluginRegistryParams["hostServices"];
  runtimeOptions?: CreatePluginRuntimeOptions;
  startupTrace?: {
    detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
  };
  pluginSdkResolution?: PluginSdkResolutionPreference;
  cache?: boolean;
  mode?: "full" | "validate" | "cli-metadata";
  onlyPluginIds?: string[];
  includeSetupOnlyChannelPlugins?: boolean;
  forceSetupOnlyChannelPlugins?: boolean;
  /** Select full runtime registration or the lightweight unconfigured-channel setup path. */
  channelPluginLoadIntent?: ChannelPluginLoadIntent;
  /** Built hosts prefer canonical checkout artifacts by default; false retains source execution. */
  preferBuiltPluginArtifacts?: boolean;
  toolDiscovery?: boolean;
  /** Native host operations supplied by a runtime composition root. */
  capabilityCatalogContext?: PluginCapabilityCatalogHostContext;
  /** Resolve declared descriptors for this family without full runtime registration. */
  capabilityCatalog?: {
    family: keyof PluginCapabilityCatalog;
    context: PluginCapabilityCatalogHostContext;
  };
  activate?: boolean;
  /** Staged Gateway candidates expose runtime APIs only after publication or owner preparation. */
  runtimeSideEffects?: boolean;
  previousRegistry?: PluginRegistry;
  replacePluginIds?: readonly string[];
  moduleRecoveries?: ReadonlyMap<string, PluginRuntimeRecovery>;
  /** Preserve host cleanup hooks before failed registration removes its contributions. */
  prepareRegistrationFailureCleanup?: (registry: PluginRegistry, record: PluginRecord) => void;
  /** Validate captured source before evaluation; this never grants plugin authority. */
  expectedSourceDigests?: Readonly<Record<string, string>>;
  loadModules?: boolean;
  throwOnLoadError?: boolean;
  manifestRegistry?: PluginManifestRegistry;
  discovery?: PluginDiscoveryResult;
};
