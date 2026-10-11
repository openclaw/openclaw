import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { getPluginRecordRegistry, isPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  bindGatewayContextResolver,
  getCanonicalGatewayContextResolver,
} from "./runtime/gateway-request-scope.js";

// Channel incarnations on one Gateway root supersede each other across registries;
// distinct Gateway roots keep independent owners for the same channel id.
type ChannelSlotClaim = { record: PluginRecord; registry: PluginRegistry };
const currentChannelClaimByGatewayRoot = new WeakMap<object, Map<string, ChannelSlotClaim>>();
const channelSuccessorByRecord = new WeakMap<PluginRecord, ChannelSlotClaim>();

/** Record `record` as the newest owner of its channel slot on one Gateway root. */
function claimGatewayRootChannelSlot(
  gatewayRoot: object | undefined,
  registry: PluginRegistry,
  record: PluginRecord,
): void {
  if (!gatewayRoot) {
    return;
  }
  let current = currentChannelClaimByGatewayRoot.get(gatewayRoot);
  if (!current) {
    current = new Map();
    currentChannelClaimByGatewayRoot.set(gatewayRoot, current);
  }
  const claim = { record, registry };
  // The newest claimant owns the slot; a stale successor link would point back at it.
  channelSuccessorByRecord.delete(record);
  const previous = current.get(record.id);
  if (previous && previous.record !== record) {
    channelSuccessorByRecord.set(previous.record, claim);
  }
  current.set(record.id, claim);
}

/**
 * A successor supersedes only while its registry stays unretired. Staged activation claims
 * before commit; rollback retires the candidate, which hands the slot back to the exact
 * predecessor. A committed successor stays live, and commit retires the predecessor anyway.
 */
export function isChannelRecordSuperseded(record: PluginRecord): boolean {
  const visited = new Set<PluginRecord>([record]);
  let successor = channelSuccessorByRecord.get(record);
  while (successor && !visited.has(successor.record)) {
    if (!isPluginRegistryRetired(getPluginRecordRegistry(successor.registry, successor.record))) {
      return true;
    }
    visited.add(successor.record);
    successor = channelSuccessorByRecord.get(successor.record);
  }
  return false;
}

/**
 * Claim the channel's slot on its Gateway root and return the fenced resolver that
 * admitted messages retain. It resolves only while the channel still owns its slot.
 */
export function claimChannelGatewayContext(params: {
  resolveGatewayContext: GatewayContextResolver | undefined;
  registry: PluginRegistry;
  record: PluginRecord;
  ownsLiveRegistrySlot: () => boolean;
}): GatewayContextResolver | undefined {
  const { resolveGatewayContext, registry, record, ownsLiveRegistrySlot } = params;
  if (!resolveGatewayContext) {
    return undefined;
  }
  const gatewayRoot = getCanonicalGatewayContextResolver(resolveGatewayContext);
  claimGatewayRootChannelSlot(gatewayRoot, registry, record);
  const scopedGatewayContext: GatewayContextResolver = () =>
    ownsLiveRegistrySlot() ? resolveGatewayContext() : undefined;
  bindGatewayContextResolver(scopedGatewayContext, gatewayRoot);
  return scopedGatewayContext;
}
