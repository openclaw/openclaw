import { loadBundledCapabilityRuntimeRegistry } from "../bundled-capability-runtime.js";
import { BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS } from "./inventory/bundled-capability-metadata.js";
import {
  loadVitestMusicGenerationProviderContractRegistry,
  loadVitestVideoGenerationProviderContractRegistry,
  type MusicGenerationProviderContractEntry,
  type VideoGenerationProviderContractEntry,
} from "./speech-vitest-registry.js";

function resolveBundledManifestPluginIdsForContract(
  contract: "videoGenerationProviders" | "musicGenerationProviders",
): string[] {
  return BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) =>
    contract === "videoGenerationProviders"
      ? entry.videoGenerationProviderIds.length > 0
      : entry.musicGenerationProviderIds.length > 0,
  )
    .map((entry) => entry.pluginId)
    .toSorted((left, right) => left.localeCompare(right));
}

function createLazyArrayView<T>(load: () => T[]): T[] {
  return new Proxy([] as T[], {
    get(_target, prop) {
      const actual = load();
      const value = Reflect.get(actual, prop, actual);
      return typeof value === "function" ? value.bind(actual) : value;
    },
    has(_target, prop) {
      return Reflect.has(load(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(load());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const actual = load();
      const descriptor = Reflect.getOwnPropertyDescriptor(actual, prop);
      if (descriptor) {
        return descriptor;
      }
      if (Reflect.has(actual, prop)) {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: Reflect.get(actual, prop, actual),
        };
      }
      return undefined;
    },
  });
}

let videoGenerationProviderContractRegistryCache: VideoGenerationProviderContractEntry[] | null =
  null;
let musicGenerationProviderContractRegistryCache: MusicGenerationProviderContractEntry[] | null =
  null;

function loadVideoGenerationProviderContractRegistry(): VideoGenerationProviderContractEntry[] {
  if (!videoGenerationProviderContractRegistryCache) {
    videoGenerationProviderContractRegistryCache = process.env.VITEST
      ? loadVitestVideoGenerationProviderContractRegistry()
      : loadBundledCapabilityRuntimeRegistry({
          pluginIds: resolveBundledManifestPluginIdsForContract("videoGenerationProviders"),
          pluginSdkResolution: "dist",
        }).videoGenerationProviders.map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
        }));
  }
  return videoGenerationProviderContractRegistryCache;
}

function loadMusicGenerationProviderContractRegistry(): MusicGenerationProviderContractEntry[] {
  if (!musicGenerationProviderContractRegistryCache) {
    musicGenerationProviderContractRegistryCache = process.env.VITEST
      ? loadVitestMusicGenerationProviderContractRegistry()
      : loadBundledCapabilityRuntimeRegistry({
          pluginIds: resolveBundledManifestPluginIdsForContract("musicGenerationProviders"),
          pluginSdkResolution: "dist",
        }).musicGenerationProviders.map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
        }));
  }
  return musicGenerationProviderContractRegistryCache;
}

export const videoGenerationProviderContractRegistry: VideoGenerationProviderContractEntry[] =
  createLazyArrayView(loadVideoGenerationProviderContractRegistry);
export const musicGenerationProviderContractRegistry: MusicGenerationProviderContractEntry[] =
  createLazyArrayView(loadMusicGenerationProviderContractRegistry);
