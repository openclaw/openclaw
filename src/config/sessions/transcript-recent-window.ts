import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  extractAssistantPhaseText,
  extractFirstTextBlock,
} from "../../shared/chat-message-content.js";
import {
  CRON_DIRECT_DELIVERY_CONTEXT_KIND,
  isTranscriptOnlyOpenClawAssistantMessage,
} from "../../shared/transcript-only-openclaw-assistant.js";
import type { TranscriptEvent } from "./session-accessor.js";

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

const normalizeTranscriptTimestamp = asFiniteNumber;

export function isWithinTranscriptWindow(
  timestamp: number | undefined,
  options: { beforeTimestampMs?: number; minTimestampMs?: number },
): boolean {
  return (
    (options.beforeTimestampMs === undefined ||
      timestamp === undefined ||
      timestamp < options.beforeTimestampMs) &&
    (options.minTimestampMs === undefined ||
      timestamp === undefined ||
      timestamp >= options.minTimestampMs)
  );
}

export function normalizeRecentTranscriptLimit(limit: number | undefined): number {
  return Math.max(1, Math.floor(limit ?? 10));
}

function readPreferredUpstreamUserText(message: {
  __openclaw?: unknown;
}): string | null | undefined {
  const meta =
    message["__openclaw"] && typeof message["__openclaw"] === "object"
      ? (message["__openclaw"] as Record<string, unknown>)
      : undefined;
  if (typeof meta?.upstreamUserText === "string") {
    return meta.upstreamUserText.trim();
  }
  return meta?.mirrorOrigin ? null : undefined;
}

export function extractRecentConversationText(
  event: TranscriptEvent,
  options: ReadRecentSessionConversationTextOptions = {},
): SessionRecentConversationText | undefined {
  // SAFETY: every field is read as unknown and narrowed before use.
  const parsed = event as {
    id?: unknown;
    message?: unknown;
  };
  // SAFETY: an optional record of unknown fields; each is type-checked below.
  const message = parsed.message as
    | {
        role?: unknown;
        timestamp?: unknown;
        provenance?: unknown;
        provider?: unknown;
        model?: unknown;
        openclawDeliveryMirror?: unknown;
        __openclaw?: unknown;
      }
    | undefined;
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
  const provenance =
    message.provenance && typeof message.provenance === "object"
      ? (message.provenance as { sourceChannel?: unknown }) // SAFETY: object-guarded; field re-checked.
      : undefined;
  return {
    ...(typeof parsed.id === "string" && parsed.id ? { id: parsed.id } : {}),
    role: message.role,
    text,
    ...(normalizeTranscriptTimestamp(message.timestamp) !== undefined
      ? { timestamp: normalizeTranscriptTimestamp(message.timestamp) }
      : {}),
    ...(typeof provenance?.sourceChannel === "string" && provenance.sourceChannel.trim()
      ? { sourceChannel: provenance.sourceChannel.trim() }
      : {}),
  };
}
