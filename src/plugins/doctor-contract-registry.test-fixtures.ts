/** Test-only controls for plugin doctor contract loading. */
import type { PluginModuleLoaderFactory } from "./plugin-module-loader-cache.js";
import { pluginDoctorContractRegistryLoaderState } from "./doctor-contract-registry-loader-state.js";

export function clearPluginDoctorContractRegistryCache(): void {
  pluginDoctorContractRegistryLoaderState.moduleLoaders.clear();
}

export function setPluginDoctorContractRegistryModuleLoaderFactoryForTest(
  factory: PluginModuleLoaderFactory | undefined,
): void {
  pluginDoctorContractRegistryLoaderState.moduleLoaderFactory = factory;
  clearPluginDoctorContractRegistryCache();
}
