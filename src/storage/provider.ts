import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { resolveStorageProvider } from "../plugins/storage-provider-registry.js";
import { filesystemStorageProvider } from "./filesystem.js";
import type { StorageProvider } from "./types.js";

export type StorageRegistry = Pick<PluginRegistry, "storageProviders">;

export async function acquireStorageProvider(params: {
  providerId: string;
  config: OpenClawConfig;
  registry?: StorageRegistry;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  provider: StorageProvider;
  registry?: StorageRegistry;
  release: () => Promise<void>;
}> {
  if (params.providerId === "filesystem") {
    return { provider: filesystemStorageProvider, release: async () => {} };
  }
  if (params.registry) {
    const provider = resolveStorageProvider(params.registry, params.providerId);
    if (!provider) {
      throw new Error(
        `Storage provider "${params.providerId}" is not loaded; check its plugin configuration.`,
      );
    }
    return { provider, registry: params.registry, release: async () => {} };
  }
  const { applyPluginAutoEnable } = await import("../config/plugin-auto-enable.js");
  const enabled = applyPluginAutoEnable({ config: params.config, env: params.env ?? process.env });
  const { resolveManifestContractRuntimePluginResolution } =
    await import("../plugins/manifest-contract-runtime.js");
  const resolution = resolveManifestContractRuntimePluginResolution({
    cfg: enabled.config,
    contract: "storageProviders",
    value: params.providerId,
  });
  if (resolution.pluginIds.length === 0) {
    throw new Error(
      `Storage provider "${params.providerId}" is unavailable; install and enable its plugin.`,
    );
  }
  const { acquirePluginRegistryForInspection } = await import("../plugins/loader.js");
  const acquisition = await acquirePluginRegistryForInspection({
    config: enabled.config,
    autoEnabledReasons: enabled.autoEnabledReasons,
    onlyPluginIds: resolution.pluginIds,
  });
  try {
    const provider = resolveStorageProvider(acquisition.registry, params.providerId);
    if (!provider) {
      throw new Error(`Plugin did not register storage provider "${params.providerId}".`);
    }
    return { provider, registry: acquisition.registry, release: acquisition.release };
  } catch (error) {
    await acquisition.release();
    throw error;
  }
}
