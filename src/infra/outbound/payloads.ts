import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import {
  isRenderablePayload,
  shouldSuppressReasoningPayload,
} from "../../auto-reply/reply/reply-payloads.js";
import type { ReplyPayload } from "../../auto-reply/types.js";

export type NormalizedOutboundPayload = {
  text: string;
  mediaUrls: string[];
  channelData?: Record<string, unknown>;
};

export type OutboundPayloadJson = {
  text: string;
  mediaUrl: string | null;
  mediaUrls?: string[];
  channelData?: Record<string, unknown>;
};

const INTERNAL_TRACE_ENVELOPE_PATTERNS = {
  noReply: /(?:^|\n)\s*NO_REPLY\b/i,
  assistantToFunctions: /(?:^|\n)[^\n]*\bassistant\s+to=functions\.[a-z0-9_]+\b/i,
} as const;

const INTERNAL_TRACE_REASONING_MARKERS: ReadonlyArray<RegExp> = [
  /\bshould\s+output\s+no_reply\b/i,
  /\b(system\s+message|system\s+instruction)\b/i,
  /\bneed\s+include\s+reply\s+tag\b/i,
  /\bexact\s+result\s+already\s+delivered\b/i,
  /(?:^|\n)\s*Final\.\s*(?:$|\n)/im,
];

function isNoReplyReasoningLeak(text: string): boolean {
  if (!INTERNAL_TRACE_ENVELOPE_PATTERNS.noReply.test(text)) {
    return false;
  }
  let matchedMarkers = 0;
  for (const marker of INTERNAL_TRACE_REASONING_MARKERS) {
    if (marker.test(text)) {
      matchedMarkers += 1;
      if (matchedMarkers >= 2) {
        return true;
      }
    }
  }
  return false;
}

function isInternalTraceLeakText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return (
    (INTERNAL_TRACE_ENVELOPE_PATTERNS.noReply.test(text) &&
      INTERNAL_TRACE_ENVELOPE_PATTERNS.assistantToFunctions.test(text)) ||
    isNoReplyReasoningLeak(text)
  );
}

function mergeMediaUrls(...lists: Array<ReadonlyArray<string | undefined> | undefined>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    if (!list) {
      continue;
    }
    for (const entry of list) {
      const trimmed = entry?.trim();
      if (!trimmed) {
        continue;
      }
      if (seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }
  return merged;
}

export function normalizeReplyPayloadsForDelivery(
  payloads: readonly ReplyPayload[],
): ReplyPayload[] {
  const normalized: ReplyPayload[] = [];
  for (const payload of payloads) {
    if (shouldSuppressReasoningPayload(payload)) {
      continue;
    }
    const parsed = parseReplyDirectives(payload.text ?? "");
    const explicitMediaUrls = payload.mediaUrls ?? parsed.mediaUrls;
    const explicitMediaUrl = payload.mediaUrl ?? parsed.mediaUrl;
    const mergedMedia = mergeMediaUrls(
      explicitMediaUrls,
      explicitMediaUrl ? [explicitMediaUrl] : undefined,
    );
    const hasMultipleMedia = (explicitMediaUrls?.length ?? 0) > 1;
    const resolvedMediaUrl = hasMultipleMedia ? undefined : explicitMediaUrl;
    const next: ReplyPayload = {
      ...payload,
      text: parsed.text ?? "",
      mediaUrls: mergedMedia.length ? mergedMedia : undefined,
      mediaUrl: resolvedMediaUrl,
      replyToId: payload.replyToId ?? parsed.replyToId,
      replyToTag: payload.replyToTag || parsed.replyToTag,
      replyToCurrent: payload.replyToCurrent || parsed.replyToCurrent,
      audioAsVoice: Boolean(payload.audioAsVoice || parsed.audioAsVoice),
    };
    if (isInternalTraceLeakText(next.text)) {
      return [];
    }
    if (parsed.isSilent && mergedMedia.length === 0) {
      continue;
    }
    if (!isRenderablePayload(next)) {
      continue;
    }
    normalized.push(next);
  }
  return normalized;
}

export function normalizeOutboundPayloads(
  payloads: readonly ReplyPayload[],
): NormalizedOutboundPayload[] {
  const normalizedPayloads: NormalizedOutboundPayload[] = [];
  for (const payload of normalizeReplyPayloadsForDelivery(payloads)) {
    const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const channelData = payload.channelData;
    const hasChannelData = Boolean(channelData && Object.keys(channelData).length > 0);
    const text = payload.text ?? "";
    if (!text && mediaUrls.length === 0 && !hasChannelData) {
      continue;
    }
    normalizedPayloads.push({
      text,
      mediaUrls,
      ...(hasChannelData ? { channelData } : {}),
    });
  }
  return normalizedPayloads;
}

export function normalizeOutboundPayloadsForJson(
  payloads: readonly ReplyPayload[],
): OutboundPayloadJson[] {
  const normalized: OutboundPayloadJson[] = [];
  for (const payload of normalizeReplyPayloadsForDelivery(payloads)) {
    normalized.push({
      text: payload.text ?? "",
      mediaUrl: payload.mediaUrl ?? null,
      mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : undefined),
      channelData: payload.channelData,
    });
  }
  return normalized;
}

export function formatOutboundPayloadLog(
  payload: Pick<NormalizedOutboundPayload, "text" | "channelData"> & {
    mediaUrls: readonly string[];
  },
): string {
  const lines: string[] = [];
  if (payload.text) {
    lines.push(payload.text.trimEnd());
  }
  for (const url of payload.mediaUrls) {
    lines.push(`MEDIA:${url}`);
  }
  return lines.join("\n");
}
