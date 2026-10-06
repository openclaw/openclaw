import type {
  ChannelMessageAdapterShape,
  ChannelMessageLiveCapability,
  ChannelMessageReceiveAckPolicy,
  DurableFinalDeliveryCapability,
  DurableFinalDeliveryRequirementMap,
  LivePreviewFinalizerCapability,
} from "./types.js";
import {
  channelMessageLiveCapabilities,
  channelMessageReceiveAckPolicies,
  durableFinalDeliveryCapabilities,
  livePreviewFinalizerCapabilities,
} from "./types.js";

type ContractProofs<TKey extends string> = Partial<Record<TKey, () => Promise<void> | void>>;
type ProofStatus = "verified" | "not_declared";
type CapabilityProofResult<TKey extends string> = { capability: TKey; status: ProofStatus };

async function verifyContractProofs<TKey extends string, TResult>(params: {
  keys: readonly TKey[];
  isDeclared: (key: TKey) => boolean;
  proofs: ContractProofs<TKey>;
  missingProofError: (key: TKey) => string;
  result: (key: TKey, status: ProofStatus) => TResult;
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

export async function verifyDurableFinalCapabilityProofs(params: {
  adapterName: string;
  capabilities?: DurableFinalDeliveryRequirementMap;
  proofs: ContractProofs<DurableFinalDeliveryCapability>;
}): Promise<CapabilityProofResult<DurableFinalDeliveryCapability>[]> {
  return await verifyContractProofs({
    keys: durableFinalDeliveryCapabilities,
    isDeclared: (capability) => params.capabilities?.[capability] === true,
    proofs: params.proofs,
    missingProofError: (capability) =>
      `${params.adapterName} declares durable final capability "${capability}" without a contract proof`,
    result: (capability, status) => ({ capability, status }),
  });
}

export async function verifyChannelMessageAdapterCapabilityProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "durableFinal">;
  proofs: ContractProofs<DurableFinalDeliveryCapability>;
}): Promise<CapabilityProofResult<DurableFinalDeliveryCapability>[]> {
  return await verifyDurableFinalCapabilityProofs({
    adapterName: params.adapterName,
    capabilities: params.adapter.durableFinal?.capabilities,
    proofs: params.proofs,
  });
}

export async function verifyChannelMessageReceiveAckPolicyAdapterProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "receive">;
  proofs: ContractProofs<ChannelMessageReceiveAckPolicy>;
}): Promise<{ policy: ChannelMessageReceiveAckPolicy; status: ProofStatus }[]> {
  const { adapterName } = params;
  const receive = params.adapter.receive;
  const declared = new Set(
    receive?.supportedAckPolicies?.length
      ? receive.supportedAckPolicies
      : receive?.defaultAckPolicy
        ? [receive.defaultAckPolicy]
        : [],
  );
  return await verifyContractProofs({
    keys: channelMessageReceiveAckPolicies,
    isDeclared: (policy) => declared.has(policy),
    proofs: params.proofs,
    missingProofError: (policy) =>
      `${adapterName} declares receive ack policy "${policy}" without a contract proof`,
    result: (policy, status) => ({ policy, status }),
  });
}

export async function verifyChannelMessageLiveFinalizerProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "live">;
  proofs: ContractProofs<LivePreviewFinalizerCapability>;
}): Promise<CapabilityProofResult<LivePreviewFinalizerCapability>[]> {
  const { adapterName } = params;
  const capabilities = params.adapter.live?.finalizer?.capabilities;
  return await verifyContractProofs({
    keys: livePreviewFinalizerCapabilities,
    isDeclared: (capability) => capabilities?.[capability] === true,
    proofs: params.proofs,
    missingProofError: (capability) =>
      `${adapterName} declares live preview finalizer capability "${capability}" without a contract proof`,
    result: (capability, status) => ({ capability, status }),
  });
}

export async function verifyChannelMessageLiveCapabilityAdapterProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "live">;
  proofs: ContractProofs<ChannelMessageLiveCapability>;
}): Promise<CapabilityProofResult<ChannelMessageLiveCapability>[]> {
  const { adapterName } = params;
  const capabilities = params.adapter.live?.capabilities;
  return await verifyContractProofs({
    keys: channelMessageLiveCapabilities,
    isDeclared: (capability) => capabilities?.[capability] === true,
    proofs: params.proofs,
    missingProofError: (capability) =>
      `${adapterName} declares live capability "${capability}" without a contract proof`,
    result: (capability, status) => ({ capability, status }),
  });
}
