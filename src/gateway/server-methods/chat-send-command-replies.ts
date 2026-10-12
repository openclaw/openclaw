import { isAudioFileName } from "@openclaw/media-core/mime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import {
  copyReplyPayloadMetadata,
  type ReplyMediaAttachment,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import type { ReplyDispatchOperation } from "../../auto-reply/reply/reply-dispatcher.types.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { collectReplyMediaEntries } from "../../infra/outbound/reply-media-entries.js";
import { normalizeMediaReferenceForComparison } from "../../media/media-reference-comparison.js";
import {
  parseInlineDirectives,
  sanitizeReplyDirectiveId,
  stripInlineDirectiveTagsForDelivery,
} from "../../utils/directive-tags.js";
import { isSuppressedControlReplyText } from "../control-reply-text.js";
import {
  combineNonStreamingReplyParts,
  sanitizeAssistantDisplayText,
} from "./chat-assistant-content.js";

export type DeliveredChatSendReply = {
  input: ReplyDispatchOperation;
  kind: "block" | "final";
};

export function readChatSendReplyPayload(input: ReplyDispatchOperation): ReplyPayload {
  return input.kind === "raw" ? input.payload : input.plan.payload;
}

export function buildTranscriptReplyTextFromInputs(
  inputs: readonly ReplyDispatchOperation[],
): string {
  const chunks = inputs
    .map((input) => {
      const payload = readChatSendReplyPayload(input);
      if (payload.isReasoning === true) {
        return "";
      }
      const parts =
        input.kind === "prepared" ? input.plan.parts : resolveSendableOutboundReplyParts(payload);
      const lines: string[] = [];
      const parsedText =
        input.kind === "raw" && payload.text?.includes("[[")
          ? parseInlineDirectives(payload.text)
          : undefined;
      const replyToId =
        sanitizeReplyDirectiveId(payload.replyToId) ??
        sanitizeReplyDirectiveId(parsedText?.replyToExplicitId);
      if (replyToId) {
        lines.push(`[[reply_to:${replyToId}]]`);
      } else if (payload.replyToCurrent || parsedText?.replyToCurrent) {
        lines.push("[[reply_to_current]]");
      }
      const text =
        input.kind === "raw" && payload.text
          ? stripInlineDirectiveTagsForDelivery(payload.text).text
          : (payload.text ?? "");
      if (text.trim() && (input.kind === "prepared" || !isSuppressedControlReplyText(text))) {
        lines.push(text);
      }
      for (const mediaUrl of parts.mediaUrls) {
        if (payload.sensitiveMedia === true) {
          continue;
        }
        const trimmed = mediaUrl.trim();
        if (trimmed) {
          lines.push(`Attachment: ${trimmed}`);
        }
      }
      if (
        (payload.audioAsVoice || parsedText?.audioAsVoice) &&
        parts.mediaUrls.some((mediaUrl) => isAudioFileName(mediaUrl))
      ) {
        lines.push("[[audio_as_voice]]");
      }
      return lines.join("\n");
    })
    .filter(Boolean);
  return combineNonStreamingReplyParts(chunks);
}

export function replaceChatSendReplyPayload(
  input: ReplyDispatchOperation,
  payload: ReplyPayload,
): ReplyDispatchOperation[] {
  return input.kind === "raw"
    ? [{ kind: "raw", payload }]
    : createStructuredOutboundPayloadPlan([payload]).map((plan) => ({ kind: "prepared", plan }));
}

function parseReplyInlineDirectives(payload: ReplyPayload) {
  return typeof payload.text === "string" && payload.text.includes("[[")
    ? parseInlineDirectives(payload.text)
    : undefined;
}

function replyMediaDedupeKeys(payload: ReplyPayload): string[] {
  return resolveSendableOutboundReplyParts(payload).mediaUrls.map((mediaUrl) =>
    normalizeMediaReferenceForComparison(mediaUrl),
  );
}

function canonicalizeReplyMedia(payload: ReplyPayload): ReplyPayload {
  const { mediaUrls } = resolveSendableOutboundReplyParts(payload);
  return copyReplyPayloadMetadata(payload, {
    ...payload,
    mediaUrl: undefined,
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
  });
}

function mergeDefinedReplySemantics(target: ReplyPayload, source: ReplyPayload): ReplyPayload {
  const sourceInlineDirectives = parseReplyInlineDirectives(source);
  const sourceReplyToId =
    sanitizeReplyDirectiveId(source.replyToId) ??
    sanitizeReplyDirectiveId(sourceInlineDirectives?.replyToExplicitId);
  const mergedMedia = mergeMediaReplySemantics(target, source, sourceInlineDirectives);
  return copyReplyPayloadMetadata(mergedMedia, {
    ...mergedMedia,
    ...(source.presentation !== undefined ? { presentation: source.presentation } : {}),
    ...(source.delivery !== undefined ? { delivery: source.delivery } : {}),
    ...(source.interactive !== undefined ? { interactive: source.interactive } : {}),
    ...(sourceReplyToId !== undefined ? { replyToId: sourceReplyToId } : {}),
    ...(source.replyToTag === true || target.replyToTag === true ? { replyToTag: true } : {}),
    ...(source.replyToCurrent === true ||
    sourceInlineDirectives?.replyToCurrent === true ||
    target.replyToCurrent === true
      ? { replyToCurrent: true }
      : {}),
    ...(source.spokenText !== undefined ? { spokenText: source.spokenText } : {}),
    ...(source.ttsSupplement !== undefined ? { ttsSupplement: source.ttsSupplement } : {}),
    ...(source.isError === true || target.isError === true ? { isError: true } : {}),
    ...(source.channelData !== undefined ? { channelData: source.channelData } : {}),
  });
}

function mergeMediaReplySemantics(
  target: ReplyPayload,
  source: ReplyPayload,
  sourceInlineDirectives = parseReplyInlineDirectives(source),
): ReplyPayload {
  let attachments = target.attachments;
  if (source.attachments?.length) {
    const sourceAttachments = new Map<string, ReplyMediaAttachment>();
    for (const { url, attachment } of collectReplyMediaEntries(source)) {
      const key = normalizeMediaReferenceForComparison(url);
      if (attachment && !sourceAttachments.has(key)) {
        sourceAttachments.set(key, attachment);
      }
    }
    attachments = collectReplyMediaEntries(target).map(({ url, attachment }) => {
      const sourceAttachment = sourceAttachments.get(normalizeMediaReferenceForComparison(url));
      if (!sourceAttachment) {
        return attachment ?? {};
      }
      const merged = Object.assign({}, attachment, sourceAttachment);
      // Equivalent media references may use different spellings in the final and retained block.
      for (const field of ["path", "url", "mediaUrl", "filePath"] as const) {
        if (merged[field] !== undefined) {
          merged[field] = url;
        }
      }
      return merged;
    });
  }
  return copyReplyPayloadMetadata(target, {
    ...target,
    ...(attachments ? { attachments } : {}),
    ...(source.trustedLocalMedia === true || target.trustedLocalMedia === true
      ? { trustedLocalMedia: true }
      : {}),
    ...(source.sensitiveMedia === true || target.sensitiveMedia === true
      ? { sensitiveMedia: true }
      : {}),
    ...(source.audioAsVoice === true ||
    sourceInlineDirectives?.audioAsVoice === true ||
    target.audioAsVoice === true
      ? { audioAsVoice: true }
      : {}),
  });
}

function hasMergeableReplySemantics(payload: ReplyPayload): boolean {
  const inlineDirectives = parseReplyInlineDirectives(payload);
  return Boolean(
    payload.trustedLocalMedia !== undefined ||
    payload.sensitiveMedia !== undefined ||
    payload.presentation ||
    payload.delivery ||
    payload.interactive ||
    payload.replyToId ||
    payload.replyToTag !== undefined ||
    payload.replyToCurrent !== undefined ||
    payload.audioAsVoice !== undefined ||
    inlineDirectives?.hasReplyTag ||
    inlineDirectives?.hasAudioTag ||
    payload.spokenText ||
    payload.ttsSupplement ||
    payload.isError !== undefined ||
    payload.channelData,
  );
}

function hasUnmergedReplySemantics(payload: ReplyPayload): boolean {
  return Boolean(
    payload.isReasoning ||
    payload.isReasoningSnapshot ||
    payload.isCompactionNotice ||
    payload.isFallbackNotice ||
    payload.isStatusNotice ||
    payload.btw,
  );
}

function mediaSetsMatch(leftMediaUrls: readonly string[], rightMediaUrls: readonly string[]) {
  return (
    leftMediaUrls.length === rightMediaUrls.length &&
    leftMediaUrls.every((mediaUrl, index) => mediaUrl === rightMediaUrls[index])
  );
}

function replyDisplayText(payload: ReplyPayload): string {
  return sanitizeAssistantDisplayText(payload.text) ?? "";
}

/** Folds raw command replies while preserving each prepared reply's ownership. */
export function selectChatSendFinalReplyInputs(params: {
  deliveredReplies: readonly DeliveredChatSendReply[];
  foldCommandBlocks: boolean;
  suppressReplies: boolean;
}): ReplyDispatchOperation[] {
  const { deliveredReplies, foldCommandBlocks, suppressReplies } = params;
  const finalInputs = deliveredReplies
    .filter((entry) => entry.kind === "final")
    .map((entry) => entry.input);
  let commandBlockInputs: ReplyDispatchOperation[] = foldCommandBlocks
    ? deliveredReplies
        .filter((entry) => entry.kind === "block")
        .map(({ input }) =>
          input.kind === "raw"
            ? { kind: "raw", payload: canonicalizeReplyMedia(input.payload) }
            : input,
        )
    : [];
  const sensitiveMediaDedupeKeys = new Set(
    finalInputs.flatMap((input) => {
      const payload = readChatSendReplyPayload(input);
      return payload.sensitiveMedia === true ? replyMediaDedupeKeys(payload).filter(Boolean) : [];
    }),
  );
  if (sensitiveMediaDedupeKeys.size > 0) {
    commandBlockInputs = commandBlockInputs.flatMap((input) => {
      const payload = readChatSendReplyPayload(input);
      if (!replyMediaDedupeKeys(payload).some((key) => sensitiveMediaDedupeKeys.has(key))) {
        return [input];
      }
      const sensitivePayload = { ...payload, sensitiveMedia: true };
      return replaceChatSendReplyPayload(
        input,
        copyReplyPayloadMetadata(payload, sensitivePayload),
      );
    });
  }
  const finalInputsForDelivery = foldCommandBlocks
    ? finalInputs.flatMap<ReplyDispatchOperation>((input) => {
        if (input.kind === "prepared") {
          return [input];
        }
        const payload = input.payload;
        const { mediaUrls: finalMediaUrls } = resolveSendableOutboundReplyParts(payload);
        const finalMediaKeys = replyMediaDedupeKeys(payload);
        const finalDisplayText = replyDisplayText(payload);
        const matchingMediaBlock =
          finalMediaUrls.length > 0
            ? commandBlockInputs.find(
                (candidate) =>
                  candidate.kind === "raw" &&
                  mediaSetsMatch(replyMediaDedupeKeys(candidate.payload), finalMediaKeys),
              )
            : undefined;
        const duplicateBlock = finalDisplayText
          ? commandBlockInputs.find(
              (candidate) =>
                candidate.kind === "raw" &&
                replyDisplayText(candidate.payload) === finalDisplayText &&
                (finalMediaUrls.length === 0 ||
                  mediaSetsMatch(replyMediaDedupeKeys(candidate.payload), finalMediaKeys)),
            )
          : matchingMediaBlock;
        if (duplicateBlock?.kind === "raw") {
          duplicateBlock.payload = mergeDefinedReplySemantics(duplicateBlock.payload, payload);
        } else if (matchingMediaBlock?.kind === "raw") {
          matchingMediaBlock.payload = mergeMediaReplySemantics(
            matchingMediaBlock.payload,
            payload,
          );
        }
        const remainingFinalMediaUrls = matchingMediaBlock ? [] : finalMediaUrls;
        if (
          remainingFinalMediaUrls.length === 0 &&
          ((duplicateBlock && !hasUnmergedReplySemantics(payload)) ||
            (!duplicateBlock &&
              !finalDisplayText &&
              !hasMergeableReplySemantics(payload) &&
              !hasUnmergedReplySemantics(payload)))
        ) {
          return [];
        }
        return [
          {
            kind: "raw" as const,
            payload: copyReplyPayloadMetadata(payload, {
              ...payload,
              mediaUrl: undefined,
              mediaUrls: remainingFinalMediaUrls.length > 0 ? remainingFinalMediaUrls : undefined,
            }),
          },
        ];
      })
    : finalInputs;
  if (suppressReplies) {
    return [];
  }
  return [...commandBlockInputs, ...finalInputsForDelivery];
}
