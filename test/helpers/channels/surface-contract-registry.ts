import {
  getBundledChannelPlugin,
  listBundledChannelPluginIds,
  listBundledChannelPlugins,
  setBundledChannelRuntime,
} from "../../../src/channels/plugins/bundled.js";
import type { ChannelId } from "../../../src/channels/plugins/channel-id.types.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  listLineAccountIds,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../../../src/plugin-sdk/line.js";
import { channelPluginSurfaceKeys, type ChannelPluginSurface } from "./manifest.js";

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
  surfaces: readonly ChannelPluginSurface[];
};

type ThreadingContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "threading">;
};

type DirectoryContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "directory">;
  coverage: "lookups" | "presence";
  cfg?: OpenClawConfig;
  accountId?: string;
};

setBundledChannelRuntime("line", {
  channel: {
    line: {
      listLineAccountIds,
      resolveDefaultLineAccountId,
      resolveLineAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) =>
        resolveLineAccount({ cfg, accountId }),
    },
  },
} as never);

let surfaceContractRegistryCache: SurfaceContractEntry[] | undefined;
const surfaceContractEntryCache = new Map<ChannelId, SurfaceContractEntry | null>();
let threadingContractRegistryCache: ThreadingContractEntry[] | undefined;
let directoryContractRegistryCache: DirectoryContractEntry[] | undefined;

function toSurfaceContractEntry(plugin: ChannelPlugin): SurfaceContractEntry {
  return {
    id: plugin.id,
    plugin,
    surfaces: channelPluginSurfaceKeys.filter((surface) => Boolean(plugin[surface])),
  };
}

function getBundledChannelPluginIdsForShard(params: {
  shardIndex: number;
  shardCount: number;
}): readonly ChannelId[] {
  return listBundledChannelPluginIds().filter(
    (_id, index) => index % params.shardCount === params.shardIndex,
  );
}

function getSurfaceContractEntry(id: ChannelId): SurfaceContractEntry | undefined {
  if (surfaceContractEntryCache.has(id)) {
    return surfaceContractEntryCache.get(id) ?? undefined;
  }
  const plugin = getBundledChannelPlugin(id);
  const entry = plugin ? toSurfaceContractEntry(plugin) : null;
  surfaceContractEntryCache.set(id, entry);
  return entry ?? undefined;
}

export function getSurfaceContractRegistry(): SurfaceContractEntry[] {
  surfaceContractRegistryCache ??= listBundledChannelPlugins().map(toSurfaceContractEntry);
  return surfaceContractRegistryCache;
}

export function getSurfaceContractRegistryShard(params: {
  shardIndex: number;
  shardCount: number;
}): SurfaceContractEntry[] {
  return getBundledChannelPluginIdsForShard(params).flatMap((id) => {
    const entry = getSurfaceContractEntry(id);
    return entry ? [entry] : [];
  });
}

export function getThreadingContractRegistry(): ThreadingContractEntry[] {
  threadingContractRegistryCache ??= getSurfaceContractRegistry()
    .filter((entry) => entry.surfaces.includes("threading"))
    .map((entry) => ({
      id: entry.id,
      plugin: entry.plugin,
    }));
  return threadingContractRegistryCache;
}

export function getThreadingContractRegistryShard(params: {
  shardIndex: number;
  shardCount: number;
}): ThreadingContractEntry[] {
  return getSurfaceContractRegistryShard(params)
    .filter((entry) => entry.surfaces.includes("threading"))
    .map((entry) => ({
      id: entry.id,
      plugin: entry.plugin,
    }));
}

const directoryPresenceOnlyIds = new Set(["whatsapp", "zalouser"]);

export function getDirectoryContractRegistry(): DirectoryContractEntry[] {
  directoryContractRegistryCache ??= getSurfaceContractRegistry()
    .filter((entry) => entry.surfaces.includes("directory"))
    .map((entry) => ({
      id: entry.id,
      plugin: entry.plugin,
      coverage: directoryPresenceOnlyIds.has(entry.id) ? "presence" : "lookups",
    }));
  return directoryContractRegistryCache;
}

export function getDirectoryContractRegistryShard(params: {
  shardIndex: number;
  shardCount: number;
}): DirectoryContractEntry[] {
  return getSurfaceContractRegistryShard(params)
    .filter((entry) => entry.surfaces.includes("directory"))
    .map((entry) => ({
      id: entry.id,
      plugin: entry.plugin,
      coverage: directoryPresenceOnlyIds.has(entry.id) ? "presence" : "lookups",
    }));
}
