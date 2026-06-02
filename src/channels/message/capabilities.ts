import type {
  DeriveDurableFinalDeliveryRequirementsParams,
  DurableFinalDeliveryCapability,
  DurableFinalDeliveryRequirementMap,
} from "./types.js";

function hasMediaPayload(
  payload: DeriveDurableFinalDeliveryRequirementsParams["payload"],
): boolean {
  if (payload.mediaUrl?.trim()) {
    return true;
  }
  // Multi-media payloads may contain empty optional slots; only non-empty URLs require the media
  // durable-final capability.
  return (
    Array.isArray(payload.mediaUrls) &&
    payload.mediaUrls.some((url) => typeof url === "string" && url.trim().length > 0)
  );
}

function setRequired(
  requirements: DurableFinalDeliveryRequirementMap,
  capability: DurableFinalDeliveryCapability,
  required: boolean | undefined,
): void {
  if (required === true) {
    requirements[capability] = true;
  }
}

/** Derives the adapter capabilities core needs before it can require durable final delivery. */
export function deriveDurableFinalDeliveryRequirements(
  params: DeriveDurableFinalDeliveryRequirementsParams,
): DurableFinalDeliveryRequirementMap {
  const requirements: DurableFinalDeliveryRequirementMap = {};
  setRequired(requirements, "text", true);
  setRequired(requirements, "media", hasMediaPayload(params.payload));
  setRequired(
    requirements,
    "replyTo",
    params.replyToId != null || params.payload.replyToId != null,
  );
  setRequired(requirements, "thread", params.threadId != null);
  setRequired(requirements, "silent", params.silent);
  // Sending hooks are required by default because durable final delivery must preserve adapter
  // lifecycle hooks unless the caller explicitly opted out.
  setRequired(requirements, "messageSendingHooks", params.messageSendingHooks !== false);
  setRequired(requirements, "payload", params.payloadTransport);
  setRequired(requirements, "batch", params.batch);
  setRequired(requirements, "reconcileUnknownSend", params.reconcileUnknownSend);
  setRequired(requirements, "afterSendSuccess", params.afterSendSuccess);
  setRequired(requirements, "afterCommit", params.afterCommit);

  for (const [capability, required] of Object.entries(params.extraCapabilities ?? {}) as Array<
    [DurableFinalDeliveryCapability, boolean | undefined]
  >) {
    setRequired(requirements, capability, required);
  }

  return requirements;
}
