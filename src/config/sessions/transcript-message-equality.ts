import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isOpenClawDeliveryMirrorAssistantMessage,
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
} from "../../shared/transcript-only-openclaw-assistant.js";

const mirrorTokenFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
const legacyMirrorCostFields = ["input", "output", "cacheRead", "cacheWrite", "total"];

function isZeroTokenMirrorUsage(usage: unknown): usage is Record<string, unknown> {
  return (
    isRecord(usage) &&
    Object.keys(usage).length === mirrorTokenFields.length + 1 &&
    mirrorTokenFields.every((field) => usage[field] === 0) &&
    isRecord(usage.cost)
  );
}

export function messagesMatchForIdempotentReplay(stored: unknown, candidate: unknown): boolean {
  const storedDelivery = isRecord(stored) ? stored.openclawDelivery : undefined;
  // Shipped core and SDK mirrors did not retain URLs. Compare their original representation
  // without rewriting accepted bytes; an explicit mediaUrls field stays strict.
  const legacyMediaMirror =
    isRecord(stored) &&
    isOpenClawDeliveryMirrorAssistantMessage(stored) &&
    (stored.api === OPENCLAW_TRANSCRIPT_ARTIFACT_API || stored.api === "openai-responses") &&
    (storedDelivery === undefined ||
      (isRecord(storedDelivery) && !Object.hasOwn(storedDelivery, "mediaUrls")));
  const serializedShape = (message: unknown, projectLegacyMedia = false): unknown => {
    if (!isRecord(message)) {
      return message;
    }
    const { timestamp: _timestamp, ...stable } = message;
    if (
      projectLegacyMedia &&
      isRecord(stable.openclawDelivery) &&
      Array.isArray(stable.openclawDelivery.mediaUrls) &&
      stable.openclawDelivery.mediaUrls.every((url) => typeof url === "string")
    ) {
      const { mediaUrls: _mediaUrls, ...delivery } = stable.openclawDelivery;
      if (storedDelivery === undefined && Object.keys(delivery).length === 0) {
        delete stable.openclawDelivery;
      } else {
        stable.openclawDelivery = delivery;
      }
    }
    const serialized = JSON.stringify(stable);
    return serialized === undefined ? undefined : JSON.parse(serialized);
  };
  const storedShape = serializedShape(stored);
  const candidateShape = serializedShape(candidate, legacyMediaMirror);
  if (isDeepStrictEqual(storedShape, candidateShape)) {
    return true;
  }
  // Recognize only the shipped mirror format, not caller authority or measured provider usage.
  // Replay keeps the accepted row and its usage unchanged; this projection is comparison-only.
  if (
    !isRecord(storedShape) ||
    !isRecord(candidateShape) ||
    !isOpenClawDeliveryMirrorAssistantMessage(storedShape) ||
    !isOpenClawDeliveryMirrorAssistantMessage(candidateShape) ||
    (storedShape.api !== OPENCLAW_TRANSCRIPT_ARTIFACT_API &&
      storedShape.api !== "openai-responses") ||
    candidateShape.api !== storedShape.api ||
    typeof storedShape.idempotencyKey !== "string" ||
    !storedShape.idempotencyKey.trim() ||
    candidateShape.idempotencyKey !== storedShape.idempotencyKey ||
    storedShape.stopReason !== "stop" ||
    candidateShape.stopReason !== "stop" ||
    !isZeroTokenMirrorUsage(storedShape.usage) ||
    !isZeroTokenMirrorUsage(candidateShape.usage)
  ) {
    return false;
  }
  const storedCost = storedShape.usage.cost;
  const candidateCost = candidateShape.usage.cost;
  if (
    !isRecord(storedCost) ||
    Object.keys(storedCost).length !== legacyMirrorCostFields.length ||
    !legacyMirrorCostFields.every((field) => storedCost[field] === 0) ||
    !isRecord(candidateCost) ||
    Object.keys(candidateCost).length !== 0
  ) {
    return false;
  }
  return isDeepStrictEqual(storedShape, {
    ...candidateShape,
    usage: { ...candidateShape.usage, cost: storedCost },
  });
}
