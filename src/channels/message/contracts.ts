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

export type DurableFinalCapabilityProof = () => Promise<void> | void;

export type DurableFinalCapabilityProofMap = Partial<
  Record<DurableFinalDeliveryCapability, DurableFinalCapabilityProof>
>;

export type DurableFinalCapabilityProofResult = {
  /** Capability checked in canonical capability order. */
  capability: DurableFinalDeliveryCapability;
  /** Whether the capability was declared and proved by the adapter test. */
  status: "verified" | "not_declared";
};

export type LivePreviewFinalizerCapabilityProof = () => Promise<void> | void;

export type ChannelMessageLiveCapabilityProof = () => Promise<void> | void;

export type ChannelMessageReceiveAckPolicyProof = () => Promise<void> | void;

export type LivePreviewFinalizerCapabilityProofMap = Partial<
  Record<LivePreviewFinalizerCapability, LivePreviewFinalizerCapabilityProof>
>;

export type ChannelMessageLiveCapabilityProofMap = Partial<
  Record<ChannelMessageLiveCapability, ChannelMessageLiveCapabilityProof>
>;

export type ChannelMessageReceiveAckPolicyProofMap = Partial<
  Record<ChannelMessageReceiveAckPolicy, ChannelMessageReceiveAckPolicyProof>
>;

export type LivePreviewFinalizerCapabilityProofResult = {
  /** Finalizer capability checked in canonical capability order. */
  capability: LivePreviewFinalizerCapability;
  /** Whether the capability was declared and proved by the adapter test. */
  status: "verified" | "not_declared";
};

export type ChannelMessageLiveCapabilityProofResult = {
  /** Live-message capability checked in canonical capability order. */
  capability: ChannelMessageLiveCapability;
  /** Whether the capability was declared and proved by the adapter test. */
  status: "verified" | "not_declared";
};

export type ChannelMessageReceiveAckPolicyProofResult = {
  /** Receive acknowledgement policy checked in canonical policy order. */
  policy: ChannelMessageReceiveAckPolicy;
  /** Whether the policy was declared and proved by the adapter test. */
  status: "verified" | "not_declared";
};

/** List declared durable-final capabilities in canonical order. */
export function listDeclaredDurableFinalCapabilities(
  capabilities: DurableFinalDeliveryRequirementMap | undefined,
): DurableFinalDeliveryCapability[] {
  return durableFinalDeliveryCapabilities.filter(
    (capability) => capabilities?.[capability] === true,
  );
}

/** List declared live-preview finalizer capabilities in canonical order. */
export function listDeclaredLivePreviewFinalizerCapabilities(
  capabilities: LivePreviewFinalizerCapabilityMap | undefined,
): LivePreviewFinalizerCapability[] {
  return livePreviewFinalizerCapabilities.filter(
    (capability) => capabilities?.[capability] === true,
  );
}

/** List declared live-message capabilities in canonical order. */
export function listDeclaredChannelMessageLiveCapabilities(
  capabilities: Partial<Record<ChannelMessageLiveCapability, boolean>> | undefined,
): ChannelMessageLiveCapability[] {
  return channelMessageLiveCapabilities.filter((capability) => capabilities?.[capability] === true);
}

/** List receive acknowledgement policies, falling back from supported policies to the default. */
export function listDeclaredReceiveAckPolicies(
  receive: ChannelMessageAdapterShape["receive"] | undefined,
): ChannelMessageReceiveAckPolicy[] {
  const declared = receive?.supportedAckPolicies?.length
    ? receive.supportedAckPolicies
    : receive?.defaultAckPolicy
      ? [receive.defaultAckPolicy]
      : [];
  return channelMessageReceiveAckPolicies.filter((policy) => declared.includes(policy));
}

/** Run one proof for every declared durable-final capability and fail on missing proofs. */
export async function verifyDurableFinalCapabilityProofs(params: {
  adapterName: string;
  capabilities?: DurableFinalDeliveryRequirementMap;
  proofs: DurableFinalCapabilityProofMap;
}): Promise<DurableFinalCapabilityProofResult[]> {
  const results: DurableFinalCapabilityProofResult[] = [];
  for (const capability of durableFinalDeliveryCapabilities) {
    if (params.capabilities?.[capability] !== true) {
      results.push({ capability, status: "not_declared" });
      continue;
    }
    const proof = params.proofs[capability];
    if (!proof) {
      throw new Error(
        `${params.adapterName} declares durable final capability "${capability}" without a contract proof`,
      );
    }
    await proof();
    results.push({ capability, status: "verified" });
  }
  return results;
}

/** Run one proof for every declared live-preview finalizer capability. */
export async function verifyLivePreviewFinalizerCapabilityProofs(params: {
  adapterName: string;
  capabilities?: LivePreviewFinalizerCapabilityMap;
  proofs: LivePreviewFinalizerCapabilityProofMap;
}): Promise<LivePreviewFinalizerCapabilityProofResult[]> {
  const results: LivePreviewFinalizerCapabilityProofResult[] = [];
  for (const capability of livePreviewFinalizerCapabilities) {
    if (params.capabilities?.[capability] !== true) {
      results.push({ capability, status: "not_declared" });
      continue;
    }
    const proof = params.proofs[capability];
    if (!proof) {
      throw new Error(
        `${params.adapterName} declares live preview finalizer capability "${capability}" without a contract proof`,
      );
    }
    await proof();
    results.push({ capability, status: "verified" });
  }
  return results;
}

/** Run one proof for every declared live-message capability. */
export async function verifyChannelMessageLiveCapabilityProofs(params: {
  adapterName: string;
  capabilities?: Partial<Record<ChannelMessageLiveCapability, boolean>>;
  proofs: ChannelMessageLiveCapabilityProofMap;
}): Promise<ChannelMessageLiveCapabilityProofResult[]> {
  const results: ChannelMessageLiveCapabilityProofResult[] = [];
  for (const capability of channelMessageLiveCapabilities) {
    if (params.capabilities?.[capability] !== true) {
      results.push({ capability, status: "not_declared" });
      continue;
    }
    const proof = params.proofs[capability];
    if (!proof) {
      throw new Error(
        `${params.adapterName} declares live capability "${capability}" without a contract proof`,
      );
    }
    await proof();
    results.push({ capability, status: "verified" });
  }
  return results;
}

/** Run one proof for every declared receive acknowledgement policy. */
export async function verifyChannelMessageReceiveAckPolicyProofs(params: {
  adapterName: string;
  receive?: ChannelMessageAdapterShape["receive"];
  proofs: ChannelMessageReceiveAckPolicyProofMap;
}): Promise<ChannelMessageReceiveAckPolicyProofResult[]> {
  const declared = new Set(listDeclaredReceiveAckPolicies(params.receive));
  const results: ChannelMessageReceiveAckPolicyProofResult[] = [];
  for (const policy of channelMessageReceiveAckPolicies) {
    if (!declared.has(policy)) {
      results.push({ policy, status: "not_declared" });
      continue;
    }
    const proof = params.proofs[policy];
    if (!proof) {
      throw new Error(
        `${params.adapterName} declares receive ack policy "${policy}" without a contract proof`,
      );
    }
    await proof();
    results.push({ policy, status: "verified" });
  }
  return results;
}

/** Verify durable-final capabilities declared on a full channel message adapter. */
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

/** Verify receive acknowledgement policies declared on a full channel message adapter. */
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

/** Verify live-preview finalizer capabilities declared on a full channel message adapter. */
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

/** Verify live-message capabilities declared on a full channel message adapter. */
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
