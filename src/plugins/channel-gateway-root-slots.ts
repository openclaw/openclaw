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
// The claim each generation displaced, so a retired candidate can be compacted out of the
// slot's history in favour of the exact predecessor it never actually replaced.
const channelPredecessorByRecord = new WeakMap<PluginRecord, ChannelSlotClaim>();

function isChannelSlotClaimRetired(claim: ChannelSlotClaim): boolean {
  return isPluginRegistryRetired(getPluginRecordRegistry(claim.registry, claim.record));
}

/**
 * The newest claim that can still own the slot. A retired candidate never owned it, so the
 * slot belongs to the claim it displaced; appending behind the retired candidate instead would
 * grow one generation per failed replacement, and every generation strongly retains the next
 * record and its whole registry.
 */
function resolveLiveChannelSlotClaim(
  claim: ChannelSlotClaim | undefined,
): ChannelSlotClaim | undefined {
  const visited = new Set<PluginRecord>();
  let candidate = claim;
  while (candidate && !visited.has(candidate.record) && isChannelSlotClaimRetired(candidate)) {
    visited.add(candidate.record);
    candidate = channelPredecessorByRecord.get(candidate.record);
  }
  return candidate && !visited.has(candidate.record) ? candidate : undefined;
}

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
  const previous = resolveLiveChannelSlotClaim(current.get(record.id));
  // The newest claimant owns the slot; a stale link would point back at it.
  channelSuccessorByRecord.delete(record);
  channelPredecessorByRecord.delete(record);
  if (previous && previous.record !== record) {
    // Overwriting the predecessor's single successor link is what releases every retired
    // generation compacted away above: nothing else references them once `current` moves.
    channelSuccessorByRecord.set(previous.record, claim);
    channelPredecessorByRecord.set(record, previous);
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
    if (!isChannelSlotClaimRetired(successor)) {
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
