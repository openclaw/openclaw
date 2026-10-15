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
// slot's history in favour of the exact predecessor it never actually replaced. These links are
// deliberately non-owning: the slot's current claim is the authoritative live owner, and a
// generation nobody else holds can neither own the slot nor be restored to it. Owning links here
// would pin one retired registry per successful replacement for the Gateway root's lifetime,
// because commit has no hook into this module to clear them.
type ChannelSlotClaimRef = { record: WeakRef<PluginRecord>; registry: WeakRef<PluginRegistry> };
const channelPredecessorByRecord = new WeakMap<PluginRecord, ChannelSlotClaimRef>();

function isChannelSlotClaimRetired(claim: ChannelSlotClaim): boolean {
  return isPluginRegistryRetired(getPluginRecordRegistry(claim.registry, claim.record));
}

function readChannelSlotPredecessor(record: PluginRecord): ChannelSlotClaim | undefined {
  const reference = channelPredecessorByRecord.get(record);
  const predecessorRecord = reference?.record.deref();
  const predecessorRegistry = reference?.registry.deref();
  return predecessorRecord && predecessorRegistry
    ? { record: predecessorRecord, registry: predecessorRegistry }
    : undefined;
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
    candidate = readChannelSlotPredecessor(candidate.record);
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
    channelPredecessorByRecord.set(record, {
      record: new WeakRef(previous.record),
      registry: new WeakRef(previous.registry),
    });
  }
  current.set(record.id, claim);
}

/**
 * A successor supersedes only while its registry stays unretired. Staged activation claims
 * before commit; rollback retires the candidate, which hands the slot back to the exact
 * predecessor. A committed successor stays live, and commit retires the predecessor anyway.
 *
 * Successor links stay owning on purpose: answering this from weak references would make a
 * live record's fence depend on when the collector ran. Retired links crossed on the way are
 * spliced out instead, which cannot change the answer - a retired claim never supersedes -
 * and keeps a long chain of committed generations from being held by one stale binding.
 */
export function isChannelRecordSuperseded(record: PluginRecord): boolean {
  const visited = new Set<PluginRecord>([record]);
  let successor = channelSuccessorByRecord.get(record);
  while (successor && !visited.has(successor.record)) {
    if (!isChannelSlotClaimRetired(successor)) {
      return true;
    }
    const next = channelSuccessorByRecord.get(successor.record);
    const displaced = channelPredecessorByRecord.get(successor.record);
    // Only the owning forward link goes. The spliced generation keeps its own non-owning
    // predecessor link, because it may still be the slot's `current` claim, and the next
    // claim reaches the live predecessor by walking back through exactly that link.
    channelSuccessorByRecord.delete(successor.record);
    if (next) {
      channelSuccessorByRecord.set(record, next);
      if (displaced) {
        channelPredecessorByRecord.set(next.record, displaced);
      } else {
        channelPredecessorByRecord.delete(next.record);
      }
    } else {
      channelSuccessorByRecord.delete(record);
    }
    visited.add(successor.record);
    successor = next;
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
