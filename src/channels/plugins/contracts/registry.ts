import { listBundledChannelPlugins } from "../bundled.js";
import type { ChannelPlugin } from "../types.js";
import {
  channelPluginSurfaceKeys,
  type ChannelPluginSurface,
} from "./manifest.js";

type SurfaceContractEntry = {
  id: string;
  plugin: Pick<
    ChannelPlugin,
    | "id"
    | "actions"
    | "setup"
    | "status"
    | "outbound"
    | "messaging"
    | "threading"
    | "directory"
    | "gateway"
  >;
  expectedSurfaces: ChannelPluginSurface[];
};

type ThreadingContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "threading">;
};

type DirectoryContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "directory">;
  coverage?: "lookups" | "presence";
};

let surfaceContractRegistryCache: SurfaceContractEntry[] | undefined;
let threadingContractRegistryCache: ThreadingContractEntry[] | undefined;
let directoryContractRegistryCache: DirectoryContractEntry[] | undefined;

const directoryPresenceOnlyIds = new Set<string>(["whatsapp", "zalouser"]);

function resolveSurfacesFromPlugin(plugin: ChannelPlugin): ChannelPluginSurface[] {
  const surfaces: ChannelPluginSurface[] = [];
  for (const surface of channelPluginSurfaceKeys) {
    if (plugin[surface] !== undefined) {
      surfaces.push(surface);
    }
  }
  return surfaces;
}

export function getSurfaceContractRegistry(): SurfaceContractEntry[] {
  surfaceContractRegistryCache ??= listBundledChannelPlugins().map((plugin) => ({
    id: plugin.id,
    plugin,
    expectedSurfaces: resolveSurfacesFromPlugin(plugin),
  }));
  return surfaceContractRegistryCache;
}

export function getThreadingContractRegistry(): ThreadingContractEntry[] {
  threadingContractRegistryCache ??= listBundledChannelPlugins()
    .filter((plugin) => Boolean(plugin.threading))
    .map((plugin) => ({ id: plugin.id, plugin }));
  return threadingContractRegistryCache;
}

export function getDirectoryContractRegistry(): DirectoryContractEntry[] {
  directoryContractRegistryCache ??= listBundledChannelPlugins()
    .filter((plugin) => Boolean(plugin.directory))
    .map((plugin) => ({
      id: plugin.id,
      plugin,
      coverage: directoryPresenceOnlyIds.has(plugin.id) ? "presence" : "lookups",
    }));
  return directoryContractRegistryCache;
}
