import { beforeAll, describe, it } from "vitest";
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
import { expectChannelSurfaceContract } from "./surface-contract-suite.js";
import {
  expectChannelDirectoryBaseContract,
  expectChannelThreadingReturnValuesNormalized,
} from "./threading-directory-contract-suites.js";

type ContractShardParams = {
  shardIndex: number;
  shardCount: number;
};

function installRegistryShard<Entry extends { id: string }, Plugin>(
  entries: readonly Entry[],
  label: string,
  testName: string,
  load: (id: string) => Promise<Plugin | undefined>,
  check: (plugin: Plugin, entry: Entry) => void | Promise<void>,
) {
  if (entries.length === 0) {
    describe(`${label} registry shard`, () => {
      // Keeps intentionally empty id-based shards visible to Vitest.
      it("has no matching bundled channels", () => {});
    });
    return;
  }
  const pluginCache = new Map<string, Plugin | undefined>();
  beforeAll(async () => {
    await Promise.all(
      entries.map(async ({ id }) => {
        pluginCache.set(id, await load(id));
      }),
    );
  });
  for (const entry of entries) {
    describe(`${entry.id} ${label}`, () => {
      it(testName, () => {
        const plugin = pluginCache.get(entry.id);
        if (!plugin) {
          throw new Error(`Missing bundled channel plugin for ${entry.id}`);
        }
        return check(plugin, entry);
      });
    });
  }
}

export function installSurfaceContractRegistryShard(params: ContractShardParams) {
  installRegistryShard(
    getSurfaceContractRegistryShardIds(params).map((id) => ({ id })),
    "surface contracts",
    "exposes declared surface contracts",
    getBundledChannelPluginAsync,
    (plugin) => {
      for (const surface of channelPluginSurfaceKeys) {
        if (surface === "setup" ? (plugin.setupContract ?? plugin.setup) : plugin[surface]) {
          expectChannelSurfaceContract({ plugin, surface });
        }
      }
    },
  );
}

export function installDirectoryContractRegistryShard(params: ContractShardParams) {
  installRegistryShard(
    getDirectoryContractRegistryShardRefs(params),
    "directory contract",
    "exposes the base directory contract",
    getBundledChannelDirectoryPluginAsync,
    (plugin, { coverage }) => expectChannelDirectoryBaseContract({ plugin, coverage }),
  );
}

export function installThreadingContractRegistryShard(params: ContractShardParams) {
  installRegistryShard(
    getThreadingContractRegistryShardRefs(params),
    "threading contract",
    "keeps threading return values normalized",
    getBundledChannelPluginAsync,
    expectChannelThreadingReturnValuesNormalized,
  );
}

export function installPluginContractRegistryShard(params: ContractShardParams) {
  installRegistryShard(
    getPluginContractRegistryShardRefs(params),
    "plugin contract",
    "satisfies the base channel plugin contract",
    getBundledChannelPluginAsync,
    expectChannelPluginContract,
  );
}
