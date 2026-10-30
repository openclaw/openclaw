/** Loads capability providers through the canonical scoped plugin loader. */
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import { getGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import {
  acquirePluginRegistryWithInternalOverrides,
  loadOpenClawPluginsWithInternalOverrides,
} from "./loader-runtime-load.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { pluginRuntimeLoaderLogger } from "./runtime/load-context.js";
import type { PluginRuntime } from "./runtime/types.js";

function createCapabilityRegistrationRuntime(
  config: NonNullable<PluginLoadOptions["config"]>,
): Pick<PluginRuntime, "config"> {
  return {
    config: {
      current: () => config,
      mutateConfigFile: async () => {
        throw new Error("Capability discovery cannot mutate plugin configuration.");
      },
      replaceConfigFile: async () => {
        throw new Error("Capability discovery cannot replace plugin configuration.");
      },
    },
  };
}

type BundledCapabilityRuntimeParams = Pick<
  PluginLoadOptions,
  | "env"
  | "config"
  | "workspaceDir"
  | "installRecords"
  | "manifestRegistry"
  | "activationSourceConfig"
  | "autoEnabledReasons"
  | "preferBuiltPluginArtifacts"
  | "pluginSdkResolution"
> & {
  pluginIds: readonly string[];
  discovery?: PluginDiscoveryResult;
};

export function loadBundledCapabilityRuntimeRegistry(params: BundledCapabilityRuntimeParams) {
  const { options, overrides } = prepareBundledCapabilityRuntime(params);
  return loadOpenClawPluginsWithInternalOverrides(options, overrides);
}

export function acquireBundledCapabilityRuntimeRegistry(params: BundledCapabilityRuntimeParams) {
  const { options, overrides } = prepareBundledCapabilityRuntime(params);
  return acquirePluginRegistryWithInternalOverrides(options, overrides);
}

function prepareBundledCapabilityRuntime(params: BundledCapabilityRuntimeParams): {
  options: PluginLoadOptions & { cache: false; activate: false };
  overrides: Parameters<typeof loadOpenClawPluginsWithInternalOverrides>[1];
} {
  const { pluginIds: requestedPluginIds, ...loadOptions } = params;
  const env = params.env ?? process.env;
  // Only the speech owner may opt into legacy global-disable compatibility before capture.
  const config =
    params.config?.plugins?.enabled === false
      ? params.config
      : (withBundledPluginEnablementCompat({
          config: params.config,
          pluginIds: params.pluginIds,
          env,
        }) ?? {});
  const snapshot =
    !params.discovery && !params.installRecords ? getGatewayPluginMetadataSnapshot() : undefined;
  const preparedRegistry =
    params.manifestRegistry ??
    (snapshot ? (snapshot.bundledManifestRegistry ?? { plugins: [], diagnostics: [] }) : undefined);
  const discovery = preparedRegistry
    ? undefined
    : (params.discovery ??
      discoverOpenClawPlugins({
        env,
        workspaceDir: params.workspaceDir,
        installRecords: params.installRecords,
      }));
  const pluginIds = new Set(params.pluginIds);
  const manifestRegistry =
    preparedRegistry ??
    loadPluginManifestRegistryCore({
      config,
      env,
      workspaceDir: params.workspaceDir,
      installRecords: params.installRecords,
      candidates: discovery?.candidates,
      diagnostics: discovery?.diagnostics,
    });
  const scopedManifestRegistry = {
    plugins: manifestRegistry.plugins.filter(
      (plugin) => plugin.origin === "bundled" && pluginIds.has(plugin.id),
    ),
    diagnostics: manifestRegistry.diagnostics,
  };
  return {
    options: {
      ...loadOptions,
      config,
      env,
      onlyPluginIds: [...requestedPluginIds],
      cache: false,
      activate: false,
      // Channel setup entries cannot register providers; keep their runtime entry in discovery mode.
      channelPluginLoadIntent: "full",
      manifestRegistry: scopedManifestRegistry,
      logger: pluginRuntimeLoaderLogger,
    },
    overrides: {
      // Discovery needs the current config, but not the full host runtime graph. The registry
      // still supplies its scoped lazy methods around this narrow base runtime.
      runtime: createCapabilityRegistrationRuntime(config),
      moduleLoader: {
        installNativeSdkResolver: false,
        loaderFilename: import.meta.url,
      },
    },
  };
}
