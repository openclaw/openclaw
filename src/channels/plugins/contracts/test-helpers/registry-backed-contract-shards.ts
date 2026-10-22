import { beforeAll, it } from "vitest";
import { expectChannelPluginContract } from "../../../../plugin-sdk/test-helpers/channel-contract-suites.js";
import {
  getBundledChannelDirectoryPluginAsync,
  getBundledChannelPluginAsync,
} from "./bundled-channel-plugin-loader.js";
import { channelPluginSurfaceKeys } from "./manifest.js";
import { getPluginContractRegistryShardRefs } from "./registry-plugin.js";
import {
  getDirectoryContractRegistryShardRefs,
  getSurfaceContractRegistryShardIds,
  getThreadingContractRegistryShardRefs,
} from "./surface-contract-registry.js";
import {
  expectChannelDirectoryBaseContract,
  expectChannelSurfaceContract,
  expectChannelThreadingReturnValuesNormalized,
} from "./threading-directory-contract-suites.js";

type ContractShardParams = Parameters<typeof getPluginContractRegistryShardRefs>[0];

function installRegistryShard<Entry extends { id: string }, Plugin>(
  entries: readonly Entry[],
  label: string,
  load: (id: string) => Promise<Plugin | undefined>,
  check: (plugin: Plugin, entry: Entry) => void | Promise<void>,
) {
  if (entries.length === 0) {
    // Keeps intentionally empty id-based shards visible to Vitest.
    it(`${label} registry shard has no matching bundled channels`, () => {});
    return;
  }
  let pluginCache: Map<string, Plugin | undefined>;
  beforeAll(async () => {
    pluginCache = new Map(
      await Promise.all(entries.map(async ({ id }) => [id, await load(id)] as const)),
    );
  });
  it.each(entries)(`$id ${label} contracts`, (entry) => {
    const plugin = pluginCache.get(entry.id);
    if (!plugin) {
      throw new Error(`Missing bundled channel plugin for ${entry.id}`);
    }
    return check(plugin, entry);
  });
}

export const installSurfaceContractRegistryShard = (params: ContractShardParams) =>
  installRegistryShard(
    getSurfaceContractRegistryShardIds(params).map((id) => ({ id })),
    "surface contracts",
    getBundledChannelPluginAsync,
    (plugin) => {
      for (const surface of channelPluginSurfaceKeys) {
        if (surface === "setup" ? (plugin.setupContract ?? plugin.setup) : plugin[surface]) {
          expectChannelSurfaceContract({ plugin, surface });
        }
      }
    },
  );

export const installDirectoryContractRegistryShard = (params: ContractShardParams) =>
  installRegistryShard(
    getDirectoryContractRegistryShardRefs(params),
    "directory contract",
    getBundledChannelDirectoryPluginAsync,
    (plugin, { coverage }) => expectChannelDirectoryBaseContract({ plugin, coverage }),
  );

export const installThreadingContractRegistryShard = (params: ContractShardParams) =>
  installRegistryShard(
    getThreadingContractRegistryShardRefs(params),
    "threading contract",
    getBundledChannelPluginAsync,
    expectChannelThreadingReturnValuesNormalized,
  );

export const installPluginContractRegistryShard = (params: ContractShardParams) =>
  installRegistryShard(
    getPluginContractRegistryShardRefs(params),
    "plugin contract",
    getBundledChannelPluginAsync,
    expectChannelPluginContract,
  );
