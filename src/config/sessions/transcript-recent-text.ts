import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  asOptionalRecord,
  asOptionalObjectRecord,
} from "@openclaw/normalization-core/record-coerce";
import {
  extractAssistantPhaseText,
  extractFirstTextBlock,
  readTerminalSourceReplyDeliveryMirror,
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

function readPreferredUpstreamUserText(message: {
  __openclaw?: unknown;
}): string | null | undefined {
  const meta = asOptionalObjectRecord(message["__openclaw"]);
  if (typeof meta?.upstreamUserText === "string") {
    return meta.upstreamUserText.trim();
  }
  return meta?.mirrorOrigin ? null : undefined;
}

export type SessionRecentConversationText = {
  id?: string;
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
  sourceChannel?: string;
};

export type ReadRecentSessionConversationTextOptions = {
  beforeTimestampMs?: number;
  deliveryOnly?: boolean;
  includeCronDirectDeliveryContext?: boolean;
  includeMessageToolSourceReplies?: boolean;
  limit?: number;
  minTimestampMs?: number;
  role?: "user" | "assistant";
  preferUpstreamUserText?: boolean;
};

type ExtractedRecentConversationText = {
  deliveryOnly: boolean;
  entry: SessionRecentConversationText;
};

function extractRecentConversationText(
  event: TranscriptEvent,
  options: ReadRecentSessionConversationTextOptions = {},
): ExtractedRecentConversationText | undefined {
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
  const transcriptOnlyAssistant =
    message.role === "assistant" && isTranscriptOnlyOpenClawAssistantMessage(message);
  const deliveryOnly =
    transcriptOnlyAssistant &&
    (includeCronDirectDeliveryContext ||
      Boolean(
        options.includeMessageToolSourceReplies && readTerminalSourceReplyDeliveryMirror(message),
      ));
  if (transcriptOnlyAssistant && !deliveryOnly) {
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
  const timestamp = asFiniteNumber(message.timestamp);
  return {
    deliveryOnly,
    entry: {
      ...(typeof parsed?.id === "string" && parsed.id ? { id: parsed.id } : {}),
      role: message.role,
      text,
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(typeof provenance?.sourceChannel === "string" && provenance.sourceChannel.trim()
        ? { sourceChannel: provenance.sourceChannel.trim() }
        : {}),
    },
  };
}

/** Select recent text inside the caller's single transcript snapshot. */
export function readRecentTranscriptConversationText(
  readPage: (
    options: SessionTranscriptBoundedMessageTailOptions,
  ) => SessionTranscriptBoundedMessageTailPage,
  options: ReadRecentSessionConversationTextOptions = {},
): SessionRecentConversationText[] {
  const limit = Math.max(1, Math.floor(options.limit ?? 10));
  const pageSize = 250;
  const recent: ExtractedRecentConversationText[] = [];
  for (let offset = 0; recent.length < limit; offset += pageSize) {
    const page = readPage({ maxMessages: pageSize, maxBytes: Number.MAX_SAFE_INTEGER, offset });
    for (const event of page.events.toReversed()) {
      const extracted = extractRecentConversationText(event.event, options);
      if (
        extracted &&
        (options.beforeTimestampMs === undefined ||
          extracted.entry.timestamp === undefined ||
          extracted.entry.timestamp < options.beforeTimestampMs) &&
        (options.minTimestampMs === undefined ||
          extracted.entry.timestamp === undefined ||
          extracted.entry.timestamp >= options.minTimestampMs)
      ) {
        recent.push(extracted);
        if (recent.length >= limit) {
          break;
        }
      }
    }
    if (offset + page.scannedMessages >= page.totalMessages) {
      break;
    }
  }
  return recent
    .toReversed()
    .flatMap(({ deliveryOnly, entry }) => (!options.deliveryOnly || deliveryOnly ? [entry] : []));
}
