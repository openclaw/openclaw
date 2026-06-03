import { loadBundledPluginPublicSurface } from "../../../../test-utils/bundled-plugin-public-surface.js";
import { listBundledChannelPluginIds as listCatalogBundledChannelPluginIds } from "../../bundled-ids.js";
import type { ChannelId } from "../../channel-id.types.js";
import type { ChannelPlugin } from "../../types.js";

// Loads bundled channel plugin public surfaces for core contract tests without
// reaching into extension-private source paths.
type ChannelPluginApiModule = Record<string, unknown>;

const channelPluginCache = new Map<ChannelId, ChannelPlugin | null>();
const channelPluginPromiseCache = new Map<ChannelId, Promise<ChannelPlugin | null>>();

function isChannelPlugin(value: unknown): value is ChannelPlugin {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Partial<ChannelPlugin>).id === "string" &&
    Boolean((value as Partial<ChannelPlugin>).meta) &&
    Boolean((value as Partial<ChannelPlugin>).config)
  );
}

export function listBundledChannelPluginIds(): readonly ChannelId[] {
  return listCatalogBundledChannelPluginIds() as ChannelId[];
}

/** Returns a bundled channel plugin from its generated public API artifact. */
export async function getBundledChannelPluginAsync(
  id: ChannelId,
): Promise<ChannelPlugin | undefined> {
  if (channelPluginCache.has(id)) {
    return channelPluginCache.get(id) ?? undefined;
  }

  const cachedPromise = channelPluginPromiseCache.get(id);
  if (cachedPromise) {
    return (await cachedPromise) ?? undefined;
  }

  // Cache both resolved plugins and in-flight loads so sharded contract suites
  // do not repeatedly import the same generated plugin artifact.
  const loading = loadBundledPluginPublicSurface<ChannelPluginApiModule>({
    pluginId: id,
    artifactBasename: "channel-plugin-api.js",
  })
    .then((loaded) => {
      const plugin = Object.values(loaded).find(isChannelPlugin) ?? null;
      channelPluginCache.set(id, plugin);
      return plugin;
    })
    .finally(() => {
      channelPluginPromiseCache.delete(id);
    });
  channelPluginPromiseCache.set(id, loading);
  return (await loading) ?? undefined;
}
