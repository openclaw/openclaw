// Runtime boundary for resolving provider auth choices from plugins.
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import { loadInstalledPluginIndexWithDiscovery } from "./installed-plugin-index.js";
import {
  resolveProviderPluginChoiceCore as resolveProviderPluginChoiceImpl,
  runProviderModelSelectedHookCore as runProviderModelSelectedHook,
} from "./provider-wizard.js";
import { resolvePluginProvidersCore as resolvePluginProvidersImpl } from "./providers.runtime.js";
import { resolvePluginSetupProviderCore as resolvePluginSetupProvider } from "./setup-registry.js";

type ResolveProviderPluginChoice =
  typeof import("./provider-wizard.js").resolveProviderPluginChoiceCore;
type ResolvePluginProviders = typeof import("./providers.runtime.js").resolvePluginProvidersCore;

export { runProviderModelSelectedHook, resolvePluginSetupProvider };

/** Runtime wrapper for provider plugin wizard choice resolution. */
export function resolveProviderPluginChoice(
  ...args: Parameters<ResolveProviderPluginChoice>
): ReturnType<ResolveProviderPluginChoice> {
  return resolveProviderPluginChoiceImpl(...args);
}

/** Runtime wrapper for registered model provider discovery. */
export function resolvePluginProviders(
  params: Parameters<ResolvePluginProviders>[0],
  preparedInstallRecords?: Record<string, PluginInstallRecord>,
): ReturnType<ResolvePluginProviders> {
  if (!preparedInstallRecords) {
    return resolvePluginProvidersImpl(params);
  }
  // The async auth owner supplies fresh installer facts and retains their cache through its consumer.
  const pluginMetadataSnapshot = loadInstalledPluginIndexWithDiscovery({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    installRecords: {
      ...loadInstalledPluginIndexInstallRecordsSync({ env: params.env }),
      ...preparedInstallRecords,
    },
  });
  return resolvePluginProvidersImpl({ ...params, pluginMetadataSnapshot });
}
