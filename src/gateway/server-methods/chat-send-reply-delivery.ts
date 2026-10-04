import type { ReplyDeliveryState } from "../../agents/reply-completion.js";
import type { SessionTranscriptWatermark } from "../../config/sessions/session-accessor.sqlite-transcript-watermark-read.js";
import type { SessionTranscriptAnchorFacts } from "../../config/sessions/session-transcript-anchor-read.kernel.js";

/** Decide receipt coverage from one current anchor snapshot and the observed transcript bounds. */
export function resolveChatReplyDeliveryFromAnchors(params: {
  facts: SessionTranscriptAnchorFacts;
  admissionId: string;
  inputId: string;
  messageId: string;
  afterSeq: number;
  watermark: SessionTranscriptWatermark;
  currentWatermark: SessionTranscriptWatermark;
}): ReplyDeliveryState | undefined {
  const { facts, afterSeq, watermark, currentWatermark } = params;
  const admitted = facts.anchors.find((entry) => entry.entryId === params.admissionId);
  const input = facts.anchors.find((entry) => entry.entryId === params.inputId);
  const anchor = facts.anchors.find((entry) => entry.entryId === params.messageId);
  if (!admitted || !input) {
    return "missing";
  }
  if (
    !anchor ||
    anchor.rawSeq <= afterSeq ||
    anchor.activeMessagePosition <= input.activeMessagePosition
  ) {
    return undefined;
  }
  if (
    facts.tail?.entries.some(
      (entry) =>
        entry.role === "user" &&
        entry.anchor &&
        entry.anchor.activeMessagePosition > anchor.activeMessagePosition,
    )
  ) {
    return "missing";
  }
  if (
    currentWatermark.generation !== watermark.generation ||
    currentWatermark.maxSeq !== watermark.maxSeq ||
    anchor.generation !== currentWatermark.generation ||
    facts.tail?.lastSeq !== currentWatermark.maxSeq
  ) {
    return "pending";
  }
  return "delivered";
}
