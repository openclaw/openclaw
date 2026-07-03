// Identifies OpenClaw-authored assistant rows that are transcript bookkeeping,
// not provider model output. Some history surfaces keep gateway-injected rows
// visible, so use the narrower delivery-mirror predicate when visibility matters.
export const OPENCLAW_TRANSCRIPT_ARTIFACT_API = "openclaw-transcript" as const;
export const OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER = "openclaw" as const;
export const OPENCLAW_DELIVERY_MIRROR_MODEL = "delivery-mirror" as const;
const OPENCLAW_GATEWAY_INJECTED_MODEL = "gateway-injected" as const;

const TRANSCRIPT_ONLY_OPENCLAW_ASSISTANT_MODELS = new Set<string>([
  OPENCLAW_DELIVERY_MIRROR_MODEL,
  OPENCLAW_GATEWAY_INJECTED_MODEL,
]);

export function isTranscriptOnlyOpenClawAssistantModel(provider: unknown, model: unknown): boolean {
  return (
    provider === OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER &&
    typeof model === "string" &&
    TRANSCRIPT_ONLY_OPENCLAW_ASSISTANT_MODELS.has(model)
  );
}

/**
 * Returns true when the message is an OpenClaw-authored transcript artifact
 * that must not be replayed to providers.
 *
 * Primary check: provider="openclaw" + model in known transcript-only set.
 * Fallback: openclawDeliveryMirror field present — catches stripped-metadata
 * survivors from session rebuild / side-branch merge (#99470).
 */
export function isTranscriptOnlyOpenClawAssistantMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const entry = message as {
    role?: unknown;
    provider?: unknown;
    model?: unknown;
    openclawDeliveryMirror?: unknown;
  };
  if (entry.role !== "assistant") {
    return false;
  }
  if (isTranscriptOnlyOpenClawAssistantModel(entry.provider, entry.model)) {
    return true;
  }
  // Session rebuild / side-branch merge can strip provider/model from
  // delivery-mirror entries while leaving openclawDeliveryMirror intact.
  // Treat any assistant message carrying that marker as transcript-only
  // so it never leaks into a provider prompt (#99470).
  if (entry.openclawDeliveryMirror != null) {
    return true;
  }
  return false;
}

export function isOpenClawMessageToolMirrorAssistantMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const entry = message as { role?: unknown; openclawMessageToolMirror?: unknown };
  return entry.role === "assistant" && entry.openclawMessageToolMirror !== undefined;
}

export function isOpenClawInternalSourceReplyMirrorAssistantMessage(message: unknown): boolean {
  if (!isOpenClawMessageToolMirrorAssistantMessage(message)) {
    return false;
  }
  const marker = (message as { openclawMessageToolMirror?: unknown }).openclawMessageToolMirror;
  return (
    Boolean(marker) &&
    typeof marker === "object" &&
    !Array.isArray(marker) &&
    (marker as { sourceReplySink?: unknown }).sourceReplySink === "internal-ui"
  );
}

export function isOpenClawDeliveryMirrorAssistantMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const entry = message as { role?: unknown; provider?: unknown; model?: unknown };
  return (
    entry.role === "assistant" &&
    entry.provider === OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER &&
    entry.model === OPENCLAW_DELIVERY_MIRROR_MODEL
  );
}
