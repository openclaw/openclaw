import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isOpenClawDeliveryMirrorAssistantMessage,
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
} from "../../shared/transcript-only-openclaw-assistant.js";

export function messagesMatchForIdempotentReplay(stored: unknown, candidate: unknown): boolean {
  const storedDelivery = isRecord(stored) ? stored.openclawDelivery : undefined;
  // v2026.9.4 mirrors did not retain URLs. Compare their original representation
  // without rewriting accepted bytes; an explicit mediaUrls field stays strict.
  const legacyMediaMirror =
    isRecord(stored) &&
    isOpenClawDeliveryMirrorAssistantMessage(stored) &&
    stored.api === OPENCLAW_TRANSCRIPT_ARTIFACT_API &&
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
  return isDeepStrictEqual(serializedShape(stored), serializedShape(candidate, legacyMediaMirror));
}
