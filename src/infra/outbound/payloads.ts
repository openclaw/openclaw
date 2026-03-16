import { resolveOutboundEmDashMode } from "../../agents/identity.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import {
  formatBtwTextForExternalDelivery,
  isRenderablePayload,
  shouldSuppressReasoningPayload,
} from "../../auto-reply/reply/reply-payloads.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { InteractiveReply } from "../../interactive/payload.js";

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

export type OutboundTextTransformOptions = {
  cfg?: OpenClawConfig;
  channel?: string;
  accountId?: string;
};

export function rewriteEmDashesAsCommas(text: string): string {
  return text
    .replace(/\s*—\s*/g, ", ")
    .replace(/,\s+([,.;:!?])/g, "$1")
    .replace(/,\s*$/g, "");
}

export function applyOutboundTextTransforms(
  text: string,
  opts?: OutboundTextTransformOptions,
): string {
  if (!text) {
    return text;
  }
  const emDashMode = opts?.cfg
    ? resolveOutboundEmDashMode(opts.cfg, {
        channel: opts.channel,
        accountId: opts.accountId,
      })
    : "preserve";
  if (emDashMode === "comma") {
    return rewriteEmDashesAsCommas(text);
  }
  return text;
}

export function normalizeReplyPayloadsForDelivery(
  payloads: readonly ReplyPayload[],
  opts?: OutboundTextTransformOptions,
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
      text: applyOutboundTextTransforms(
        formatBtwTextForExternalDelivery({
          ...payload,
          text: parsed.text ?? "",
        }) ?? "",
        opts,
      ),
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
    const hasChannelData = Boolean(channelData && Object.keys(channelData).length > 0);
    const hasInteractive = Boolean(interactive?.blocks.length);
    const text = payload.text ?? "";
    if (!text && mediaUrls.length === 0 && !hasInteractive && !hasChannelData) {
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
