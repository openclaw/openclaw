import { listBundledChannelPluginMetadata } from "../../../../plugins/bundled-channel-runtime.js";
import { loadBundledPluginFacade } from "../../../../test-utils/bundled-plugin-public-surface.js";
import type { ChannelId } from "../../channel-id.types.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../types.plugin.js";

// Share in-flight and completed imports, including missing plugins; retry failed loads.
function cachePluginLoader<T>(load: (id: ChannelId) => Promise<T | null>) {
  const cache = new Map<ChannelId, Promise<T | null>>();
  return async (id: ChannelId): Promise<T | undefined> => {
    let loading = cache.get(id);
    if (!loading) {
      loading = load(id).catch((error: unknown) => {
        cache.delete(id);
        throw error;
      });
      cache.set(id, loading);
    }
    return (await loading) ?? undefined;
  };
}

function isChannelPlugin(value: unknown): value is ChannelPlugin {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Partial<ChannelPlugin>).id === "string" &&
    Boolean((value as Partial<ChannelPlugin>).meta) &&
    Boolean((value as Partial<ChannelPlugin>).config)
  );
}

function isDirectoryPlugin(value: unknown): value is Pick<ChannelPlugin, "id" | "directory"> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Partial<ChannelPlugin>).id === "string" &&
    Boolean((value as Partial<ChannelPlugin>).directory)
  );
}

export function listBundledChannelPluginIds(): readonly ChannelId[] {
  return listBundledChannelPluginMetadata()
    .filter((metadata) => (metadata.manifest.channels?.length ?? 0) > 0)
    .map((metadata) => metadata.manifest.id)
    .toSorted((left, right) => left.localeCompare(right));
}

// The canonical test facade resolves source surfaces, never external dist artifacts.
export const getBundledChannelPluginAsync = cachePluginLoader(async (id) => {
  const artifact = await loadBundledPluginFacade<Record<string, unknown>>({
    pluginId: id,
    artifactBasename: "channel-plugin-api.js",
  });
  return Object.values(artifact).find(isChannelPlugin) ?? null;
});

export const getBundledChannelDirectoryPluginAsync = cachePluginLoader(async (id) => {
  const artifact = await optionalArtifact<Record<string, unknown>>(id, "directory-contract-api.js");
  return (
    (artifact && Object.values(artifact).find(isDirectoryPlugin)) ??
    (await getBundledChannelPluginAsync(id)) ??
    null
  );
});

// Only absent optional surfaces are ignored; broken present surfaces must fail.
async function optionalArtifact<T extends object>(
  id: ChannelId,
  artifactBasename: string,
): Promise<T | null> {
  return loadBundledPluginFacade<T>({ pluginId: id, artifactBasename }).catch((error: unknown) => {
    if (
      error instanceof Error &&
      error.message === `Unable to resolve bundled plugin public surface ${id}/${artifactBasename}`
    ) {
      return null;
    }
    throw error;
  });
}

export const getBundledChannelThreadBindingArtifactAsync = (id: ChannelId) =>
  optionalArtifact<{ defaultTopLevelPlacement?: unknown }>(id, "thread-binding-api.js");
export const getBundledChannelSessionKeyArtifactAsync = (id: ChannelId) =>
  optionalArtifact<Record<string, unknown>>(id, "session-key-api.js");
export const getBundledChannelMessageToolArtifactAsync = (id: ChannelId) =>
  optionalArtifact<{ describeMessageTool?: unknown }>(id, "message-tool-api.js");
export const getBundledChannelGatewayAuthArtifactAsync = (id: ChannelId) =>
  optionalArtifact<{ resolveGatewayAuthBypassPaths?: unknown }>(id, "gateway-auth-api.js");
