/**
 * Bundled channel plugin contract shard selectors.
 *
 * Assigns plugin ids to deterministic registry contract shards.
 */
import type { ChannelId } from "../../channel-id.types.js";
import { getSurfaceContractRegistryShardIds } from "./surface-contract-registry.js";

type PluginContractRef = {
  id: ChannelId;
};

/** Returns bundled plugin refs assigned to one contract-test shard. */
export function getPluginContractRegistryShardRefs(params: {
  shardIndex: number;
  shardCount: number;
}): PluginContractRef[] {
  return getSurfaceContractRegistryShardIds(params).map((id) => ({ id }));
}
