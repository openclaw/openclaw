import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import {
  formatBtwTextForExternalDelivery,
  isRenderablePayload,
  shouldSuppressReasoningPayload,
} from "../../auto-reply/reply/reply-payloads.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import {
  hasInteractiveReplyBlocks,
  hasReplyChannelData,
  hasReplyContent,
  type InteractiveReply,
} from "../../interactive/payload.js";

export type NormalizedOutboundPayload = {
  text: string;
  mediaUrls: string[];
  interactive?: InteractiveReply;
  channelData?: Record<string, unknown>;
};

export type OutboundPayloadJson = {
  text: string;
  mediaUrl: string | null;
  mediaUrls?: string[];
  interactive?: InteractiveReply;
  channelData?: Record<string, unknown>;
};

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
      text:
        formatBtwTextForExternalDelivery({
          ...payload,
          text: parsed.text ?? "",
        }) ?? "",
      mediaUrls: mergedMedia.length ? mergedMedia : undefined,
      mediaUrl: resolvedMediaUrl,
      replyToId: payload.replyToId ?? parsed.replyToId,
      replyToTag: payload.replyToTag || parsed.replyToTag,
      replyToCurrent: payload.replyToCurrent || parsed.replyToCurrent,
      audioAsVoice: Boolean(payload.audioAsVoice || parsed.audioAsVoice),
    };
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
    const interactive = payload.interactive;
    const channelData = payload.channelData;
    const hasChannelData = hasReplyChannelData(channelData);
    const hasInteractive = hasInteractiveReplyBlocks(interactive);
    const text = payload.text ?? "";
    if (
      !hasReplyContent({
        text,
        mediaUrls,
        interactive,
        hasChannelData,
      })
    ) {
      continue;
    }
    normalizedPayloads.push({
      text,
      mediaUrls,
      ...(hasInteractive ? { interactive } : {}),
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
      interactive: payload.interactive,
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
