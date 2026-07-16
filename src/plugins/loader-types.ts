import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRegistryParams } from "./registry-types.js";
import type { CreatePluginRuntimeOptions } from "./runtime/types.js";
import type { PluginSdkResolutionPreference } from "./sdk-alias.js";
import type { PluginLogger } from "./types.js";

export type PluginLoadOptions = {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  autoEnabledReasons?: Readonly<Record<string, string[]>>;
  workspaceDir?: string;
  installRecords?: Record<string, PluginInstallRecord>;
  // Allows callers to resolve plugin roots and load paths against an explicit env
  // instead of the process-global environment.
  env?: NodeJS.ProcessEnv;
  // Direct raw-config callers can opt into the same single env-substitution pass
  // config IO normally performs before plugin validation.
  resolveRawConfigEnvVars?: boolean;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  coreGatewayMethodNames?: readonly string[];
  hostServices?: PluginRegistryParams["hostServices"];
  runtimeOptions?: CreatePluginRuntimeOptions;
  startupTrace?: {
    detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
  };
  pluginSdkResolution?: PluginSdkResolutionPreference;
  cache?: boolean;
  mode?: "full" | "validate";
  onlyPluginIds?: string[];
  includeSetupOnlyChannelPlugins?: boolean;
  forceSetupOnlyChannelPlugins?: boolean;
  requireSetupEntryForSetupOnlyChannelPlugins?: boolean;
  /**
   * Prefer `setupEntry` for configured channel plugins that explicitly opt in
   * via package metadata because their setup entry covers the pre-listen startup surface.
   */
  preferSetupRuntimeForChannelPlugins?: boolean;
  /**
   * Load channel runtime entries even when setup entries are available. Plugin CLI
   * registration needs the runtime entry because setup entries only own setup state.
   */
  forceFullRuntimeForChannelPlugins?: boolean;
  /**
   * For hot startup paths, prefer bundled plugin JS artifacts over source TS
   * entrypoints when both are present in a source checkout.
   */
  preferBuiltPluginArtifacts?: boolean;
  toolDiscovery?: boolean;
  activate?: boolean;
  loadModules?: boolean;
  throwOnLoadError?: boolean;
  manifestRegistry?: PluginManifestRegistry;
  discovery?: PluginDiscoveryResult;
};
