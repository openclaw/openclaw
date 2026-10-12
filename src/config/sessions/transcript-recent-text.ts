import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  extractAssistantPhaseText,
  extractFirstTextBlock,
} from "../../shared/chat-message-content.js";
import {
  CRON_DIRECT_DELIVERY_CONTEXT_KIND,
  isTranscriptOnlyOpenClawAssistantMessage,
} from "../../shared/transcript-only-openclaw-assistant.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import type {
  SessionTranscriptBoundedMessageTailOptions,
  SessionTranscriptBoundedMessageTailPage,
} from "./session-accessor.sqlite-projection-read.js";
import {
  isWithinTranscriptWindow,
  normalizeRecentTranscriptLimit,
  normalizeTranscriptTimestamp,
  readPreferredUpstreamUserText,
} from "./transcript-recent-window.js";

export type SessionRecentConversationText = {
  id?: string;
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
  sourceChannel?: string;
};

export type ReadRecentSessionConversationTextOptions = {
  beforeTimestampMs?: number;
  includeCronDirectDeliveryContext?: boolean;
  limit?: number;
  minTimestampMs?: number;
  role?: "user" | "assistant";
  preferUpstreamUserText?: boolean;
};

function extractRecentConversationText(
  event: TranscriptEvent,
  options: ReadRecentSessionConversationTextOptions = {},
): SessionRecentConversationText | undefined {
  const parsed = asOptionalRecord(event);
  const message = asOptionalRecord(parsed?.message);
  if (
    !message ||
    (message.role !== "user" && message.role !== "assistant") ||
    (options.role && message.role !== options.role)
  ) {
    return undefined;
  }
  const deliveryMirror = message.openclawDeliveryMirror;
  const includeCronDirectDeliveryContext =
    options.includeCronDirectDeliveryContext === true &&
    deliveryMirror !== null &&
    typeof deliveryMirror === "object" &&
    !Array.isArray(deliveryMirror) &&
    "kind" in deliveryMirror &&
    deliveryMirror.kind === CRON_DIRECT_DELIVERY_CONTEXT_KIND;
  if (
    message.role === "assistant" &&
    isTranscriptOnlyOpenClawAssistantMessage(message) &&
    !includeCronDirectDeliveryContext
  ) {
    return undefined;
  }
  const upstreamUserText =
    options.preferUpstreamUserText && message.role === "user"
      ? readPreferredUpstreamUserText(message)
      : undefined;
  if (upstreamUserText === null) {
    return undefined;
  }
  const text =
    message.role === "assistant"
      ? extractAssistantPhaseText(message)
      : (upstreamUserText ?? extractFirstTextBlock(message)?.trim());
  if (!text) {
    return undefined;
  }
  const provenance = asOptionalRecord(message.provenance);
  const timestamp = normalizeTranscriptTimestamp(message.timestamp);
  return {
    ...(typeof parsed?.id === "string" && parsed.id ? { id: parsed.id } : {}),
    role: message.role,
    text,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(typeof provenance?.sourceChannel === "string" && provenance.sourceChannel.trim()
      ? { sourceChannel: provenance.sourceChannel.trim() }
      : {}),
  };
}

/** Select recent text inside the caller's single transcript snapshot. */
export function readRecentTranscriptConversationText(
  readPage: (
    options: SessionTranscriptBoundedMessageTailOptions,
  ) => SessionTranscriptBoundedMessageTailPage,
  options: ReadRecentSessionConversationTextOptions = {},
): SessionRecentConversationText[] {
  const limit = normalizeRecentTranscriptLimit(options.limit);
  const pageSize = 250;
  const recent: SessionRecentConversationText[] = [];
  for (let offset = 0; recent.length < limit; offset += pageSize) {
    const page = readPage({ maxMessages: pageSize, maxBytes: Number.MAX_SAFE_INTEGER, offset });
    for (const event of page.events.toReversed()) {
      const entry = extractRecentConversationText(event.event, options);
      if (entry && isWithinTranscriptWindow(entry.timestamp, options)) {
        recent.push(entry);
        if (recent.length >= limit) {
          break;
        }
      }
    }
    if (offset + page.scannedMessages >= page.totalMessages) {
      break;
    }
  }
  return recent.toReversed();
}
