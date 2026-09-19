/**
 * Channel message adapter contract verification helpers.
 *
 * Runs proof callbacks for declared durable, live-preview, live-message, and receive capabilities.
 */
import type {
  ChannelMessageAdapterShape,
  ChannelMessageLiveCapability,
  ChannelMessageReceiveAckPolicy,
  DurableFinalDeliveryCapability,
  DurableFinalDeliveryRequirementMap,
  LivePreviewFinalizerCapability,
  LivePreviewFinalizerCapabilityMap,
} from "./types.js";
import {
  channelMessageLiveCapabilities,
  channelMessageReceiveAckPolicies,
  durableFinalDeliveryCapabilities,
  livePreviewFinalizerCapabilities,
} from "./types.js";

type DurableFinalCapabilityProof = () => Promise<void> | void;
type DurableFinalCapabilityProofMap = Partial<
  Record<DurableFinalDeliveryCapability, DurableFinalCapabilityProof>
>;
type DurableFinalCapabilityProofResult = {
  capability: DurableFinalDeliveryCapability;
  status: "verified" | "not_declared";
};
type LivePreviewFinalizerCapabilityProof = () => Promise<void> | void;
type ChannelMessageLiveCapabilityProof = () => Promise<void> | void;
type ChannelMessageReceiveAckPolicyProof = () => Promise<void> | void;
type LivePreviewFinalizerCapabilityProofMap = Partial<
  Record<LivePreviewFinalizerCapability, LivePreviewFinalizerCapabilityProof>
>;
type ChannelMessageLiveCapabilityProofMap = Partial<
  Record<ChannelMessageLiveCapability, ChannelMessageLiveCapabilityProof>
>;
type ChannelMessageReceiveAckPolicyProofMap = Partial<
  Record<ChannelMessageReceiveAckPolicy, ChannelMessageReceiveAckPolicyProof>
>;
type LivePreviewFinalizerCapabilityProofResult = {
  capability: LivePreviewFinalizerCapability;
  status: "verified" | "not_declared";
};
type ChannelMessageLiveCapabilityProofResult = {
  capability: ChannelMessageLiveCapability;
  status: "verified" | "not_declared";
};
type ChannelMessageReceiveAckPolicyProofResult = {
  policy: ChannelMessageReceiveAckPolicy;
  status: "verified" | "not_declared";
};

async function verifyContractProofs<TKey extends string, TResult>(params: {
  keys: readonly TKey[];
  isDeclared: (key: TKey) => boolean;
  proofs: Partial<Record<TKey, () => Promise<void> | void>>;
  missingProofError: (key: TKey) => string;
  result: (key: TKey, status: "verified" | "not_declared") => TResult;
}): Promise<TResult[]> {
  const results: TResult[] = [];
  for (const key of params.keys) {
    if (!params.isDeclared(key)) {
      results.push(params.result(key, "not_declared"));
      continue;
    }
    const proof = params.proofs[key];
    if (!proof) {
      throw new Error(params.missingProofError(key));
    }
    await proof();
    results.push(params.result(key, "verified"));
  }
  return results;
}

/**
 * Lists declared receive acknowledgement policies, including the default policy fallback.
 */
function listDeclaredReceiveAckPolicies(
  receive: ChannelMessageAdapterShape["receive"] | undefined,
): ChannelMessageReceiveAckPolicy[] {
  const declared = receive?.supportedAckPolicies?.length
    ? receive.supportedAckPolicies
    : receive?.defaultAckPolicy
      ? [receive.defaultAckPolicy]
      : [];
  return channelMessageReceiveAckPolicies.filter((policy) => declared.includes(policy));
}

/**
 * Verifies proof callbacks for every declared durable-final delivery capability.
 */
export async function verifyDurableFinalCapabilityProofs(params: {
  adapterName: string;
  capabilities?: DurableFinalDeliveryRequirementMap;
  proofs: DurableFinalCapabilityProofMap;
}): Promise<DurableFinalCapabilityProofResult[]> {
  return await verifyContractProofs({
    keys: durableFinalDeliveryCapabilities,
    isDeclared: (capability) => params.capabilities?.[capability] === true,
    proofs: params.proofs,
    missingProofError: (capability) =>
      `${params.adapterName} declares durable final capability "${capability}" without a contract proof`,
    result: (capability, status) => ({ capability, status }),
  });
}

/**
 * Verifies proof callbacks for every declared live-preview finalizer capability.
 */
async function verifyLivePreviewFinalizerCapabilityProofs(params: {
  adapterName: string;
  capabilities?: LivePreviewFinalizerCapabilityMap;
  proofs: LivePreviewFinalizerCapabilityProofMap;
}): Promise<LivePreviewFinalizerCapabilityProofResult[]> {
  return await verifyContractProofs({
    keys: livePreviewFinalizerCapabilities,
    isDeclared: (capability) => params.capabilities?.[capability] === true,
    proofs: params.proofs,
    missingProofError: (capability) =>
      `${params.adapterName} declares live preview finalizer capability "${capability}" without a contract proof`,
    result: (capability, status) => ({ capability, status }),
  });
}

/**
 * Verifies proof callbacks for every declared live message capability.
 */
async function verifyChannelMessageLiveCapabilityProofs(params: {
  adapterName: string;
  capabilities?: Partial<Record<ChannelMessageLiveCapability, boolean>>;
  proofs: ChannelMessageLiveCapabilityProofMap;
}): Promise<ChannelMessageLiveCapabilityProofResult[]> {
  return await verifyContractProofs({
    keys: channelMessageLiveCapabilities,
    isDeclared: (capability) => params.capabilities?.[capability] === true,
    proofs: params.proofs,
    missingProofError: (capability) =>
      `${params.adapterName} declares live capability "${capability}" without a contract proof`,
    result: (capability, status) => ({ capability, status }),
  });
}

/**
 * Verifies proof callbacks for every declared receive acknowledgement policy.
 */
async function verifyChannelMessageReceiveAckPolicyProofs(params: {
  adapterName: string;
  receive?: ChannelMessageAdapterShape["receive"];
  proofs: ChannelMessageReceiveAckPolicyProofMap;
}): Promise<ChannelMessageReceiveAckPolicyProofResult[]> {
  const declared = new Set(listDeclaredReceiveAckPolicies(params.receive));
  return await verifyContractProofs({
    keys: channelMessageReceiveAckPolicies,
    isDeclared: (policy) => declared.has(policy),
    proofs: params.proofs,
    missingProofError: (policy) =>
      `${params.adapterName} declares receive ack policy "${policy}" without a contract proof`,
    result: (policy, status) => ({ policy, status }),
  });
}

/**
 * Verifies durable-final proofs from a channel message adapter declaration.
 */
export async function verifyChannelMessageAdapterCapabilityProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "durableFinal">;
  proofs: DurableFinalCapabilityProofMap;
}): Promise<DurableFinalCapabilityProofResult[]> {
  return await verifyDurableFinalCapabilityProofs({
    adapterName: params.adapterName,
    capabilities: params.adapter.durableFinal?.capabilities,
    proofs: params.proofs,
  });
}

/**
 * Verifies receive acknowledgement proofs from a channel message adapter declaration.
 */
export async function verifyChannelMessageReceiveAckPolicyAdapterProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "receive">;
  proofs: ChannelMessageReceiveAckPolicyProofMap;
}): Promise<ChannelMessageReceiveAckPolicyProofResult[]> {
  return await verifyChannelMessageReceiveAckPolicyProofs({
    adapterName: params.adapterName,
    receive: params.adapter.receive,
    proofs: params.proofs,
  });
}

/**
 * Verifies live-preview finalizer proofs from a channel message adapter declaration.
 */
export async function verifyChannelMessageLiveFinalizerProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "live">;
  proofs: LivePreviewFinalizerCapabilityProofMap;
}): Promise<LivePreviewFinalizerCapabilityProofResult[]> {
  return await verifyLivePreviewFinalizerCapabilityProofs({
    adapterName: params.adapterName,
    capabilities: params.adapter.live?.finalizer?.capabilities,
    proofs: params.proofs,
  });
}

/**
 * Verifies live message capability proofs from a channel message adapter declaration.
 */
export async function verifyChannelMessageLiveCapabilityAdapterProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "live">;
  proofs: ChannelMessageLiveCapabilityProofMap;
}): Promise<ChannelMessageLiveCapabilityProofResult[]> {
  return await verifyChannelMessageLiveCapabilityProofs({
    adapterName: params.adapterName,
    capabilities: params.adapter.live?.capabilities,
    proofs: params.proofs,
  });
}
