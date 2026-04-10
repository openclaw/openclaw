import type {
  MusicGenerationProviderPlugin,
  OpenClawPluginApi,
  VideoGenerationProviderPlugin,
} from "../../../src/plugins/types.js";
import { loadBundledPluginPublicSurfaceSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";
import { registerProviderPlugin } from "../plugins/provider-registration.js";

type BundledPluginEntryModule = {
  default: {
    register(api: OpenClawPluginApi): void | Promise<void>;
  };
};

export type BundledVideoProviderEntry = {
  pluginId: string;
  provider: VideoGenerationProviderPlugin;
};

export type BundledMusicProviderEntry = {
  pluginId: string;
  provider: MusicGenerationProviderPlugin;
};

const BUNDLED_VIDEO_PROVIDER_PLUGIN_IDS = [
  "alibaba",
  "byteplus",
  "comfy",
  "fal",
  "google",
  "minimax",
  "openai",
  "qwen",
  "runway",
  "together",
  "vydra",
  "xai",
] as const;

const BUNDLED_MUSIC_PROVIDER_PLUGIN_IDS = ["comfy", "google", "minimax"] as const;

function loadBundledPluginEntry(pluginId: string): BundledPluginEntryModule {
  return loadBundledPluginPublicSurfaceSync<BundledPluginEntryModule>({
    pluginId,
    artifactBasename: "index.js",
  });
}

async function registerBundledMediaPlugin(pluginId: string) {
  const { default: plugin } = loadBundledPluginEntry(pluginId);
  return await registerProviderPlugin({
    plugin,
    id: pluginId,
    name: pluginId,
  });
}

export async function loadBundledVideoGenerationProviders(): Promise<BundledVideoProviderEntry[]> {
  return (
    await Promise.all(
      BUNDLED_VIDEO_PROVIDER_PLUGIN_IDS.map(async (pluginId) => {
        const { videoProviders } = await registerBundledMediaPlugin(pluginId);
        return videoProviders.map((provider) => ({ pluginId, provider }));
      }),
    )
  ).flat();
}

export async function loadBundledMusicGenerationProviders(): Promise<BundledMusicProviderEntry[]> {
  return (
    await Promise.all(
      BUNDLED_MUSIC_PROVIDER_PLUGIN_IDS.map(async (pluginId) => {
        const { musicProviders } = await registerBundledMediaPlugin(pluginId);
        return musicProviders.map((provider) => ({ pluginId, provider }));
      }),
    )
  ).flat();
}
