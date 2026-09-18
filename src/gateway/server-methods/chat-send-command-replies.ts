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
import { parseInlineDirectives, sanitizeReplyDirectiveId } from "../../utils/directive-tags.js";
import { sanitizeAssistantDisplayText } from "./chat-assistant-content.js";

export type DeliveredChatSendReply = {
  input: ReplyDispatchOperation;
  kind: "block" | "final";
};

export function readChatSendReplyPayload(input: ReplyDispatchOperation): ReplyPayload {
  return input.kind === "raw" ? input.payload : input.plan.payload;
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

function replyMediaUrls(payload: ReplyPayload): string[] {
  return resolveSendableOutboundReplyParts(payload).mediaUrls;
}

function replyMediaDedupeKeys(payload: ReplyPayload): string[] {
  return replyMediaUrls(payload).map((mediaUrl) => normalizeMediaReferenceForComparison(mediaUrl));
}

function canonicalizeReplyMedia(payload: ReplyPayload): ReplyPayload {
  const mediaUrls = replyMediaUrls(payload);
  return {
    ...payload,
    mediaUrl: undefined,
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
  };
}

function mergeDefinedReplySemantics(target: ReplyPayload, source: ReplyPayload): ReplyPayload {
  const sourceInlineDirectives = parseReplyInlineDirectives(source);
  const sourceReplyToId =
    sanitizeReplyDirectiveId(source.replyToId) ??
    sanitizeReplyDirectiveId(sourceInlineDirectives?.replyToExplicitId);
  return {
    ...mergeMediaReplySemantics(target, source, sourceInlineDirectives),
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
  };
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
  return {
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
  };
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

function hasReplySemantics(payload: ReplyPayload): boolean {
  return hasMergeableReplySemantics(payload) || hasUnmergedReplySemantics(payload);
}

function mediaSetsMatch(leftMediaUrls: readonly string[], rightMediaUrls: readonly string[]) {
  if (leftMediaUrls.length !== rightMediaUrls.length) {
    return false;
  }
  return leftMediaUrls.every((mediaUrl, index) => mediaUrl === rightMediaUrls[index]);
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
  const finalPayloadEntries = deliveredReplies.filter((entry) => entry.kind === "final");
  const commandBlockPayloadEntries = foldCommandBlocks
    ? deliveredReplies.filter((entry) => entry.kind === "block")
    : [];
  let commandBlockPayloadEntriesForDelivery = commandBlockPayloadEntries.map((entry) => ({
    kind: entry.kind,
    input:
      entry.input.kind === "raw"
        ? { kind: "raw" as const, payload: canonicalizeReplyMedia(entry.input.payload) }
        : entry.input,
  }));
  const sensitiveMediaDedupeKeys = new Set(
    finalPayloadEntries.flatMap((entry) => {
      const payload = readChatSendReplyPayload(entry.input);
      return payload.sensitiveMedia === true ? replyMediaDedupeKeys(payload).filter(Boolean) : [];
    }),
  );
  if (sensitiveMediaDedupeKeys.size > 0) {
    commandBlockPayloadEntriesForDelivery = commandBlockPayloadEntriesForDelivery.flatMap(
      (entry) => {
        const payload = readChatSendReplyPayload(entry.input);
        if (!replyMediaDedupeKeys(payload).some((key) => sensitiveMediaDedupeKeys.has(key))) {
          return [entry];
        }
        const sensitivePayload = { ...payload, sensitiveMedia: true };
        return replaceChatSendReplyPayload(
          entry.input,
          entry.input.kind === "prepared"
            ? copyReplyPayloadMetadata(payload, sensitivePayload)
            : sensitivePayload,
        ).map((input) => ({ kind: entry.kind, input }));
      },
    );
  }
  const finalPayloadEntriesForDelivery = foldCommandBlocks
    ? finalPayloadEntries.flatMap((entry) => {
        if (entry.input.kind === "prepared") {
          return [entry];
        }
        const payload = entry.input.payload;
        const finalMediaUrls = replyMediaUrls(payload);
        const finalMediaKeys = replyMediaDedupeKeys(payload);
        const finalDisplayText = replyDisplayText(payload);
        const matchingMediaBlockEntry =
          finalMediaUrls.length > 0
            ? commandBlockPayloadEntriesForDelivery.find(
                (candidate) =>
                  candidate.input.kind === "raw" &&
                  mediaSetsMatch(replyMediaDedupeKeys(candidate.input.payload), finalMediaKeys),
              )
            : undefined;
        const matchingTextBlockEntry = finalDisplayText
          ? commandBlockPayloadEntriesForDelivery.find(
              (candidate) =>
                candidate.input.kind === "raw" &&
                replyDisplayText(candidate.input.payload) === finalDisplayText,
            )
          : undefined;
        const matchingMediaAndTextBlockEntry =
          finalMediaUrls.length > 0 && finalDisplayText
            ? commandBlockPayloadEntriesForDelivery.find(
                (candidate) =>
                  candidate.input.kind === "raw" &&
                  replyDisplayText(candidate.input.payload) === finalDisplayText &&
                  mediaSetsMatch(replyMediaDedupeKeys(candidate.input.payload), finalMediaKeys),
              )
            : undefined;
        const duplicateBlockEntry =
          finalMediaUrls.length > 0
            ? finalDisplayText
              ? matchingMediaAndTextBlockEntry
              : matchingMediaBlockEntry
            : finalMediaUrls.length === 0
              ? matchingTextBlockEntry
              : undefined;
        if (duplicateBlockEntry?.input.kind === "raw") {
          duplicateBlockEntry.input = {
            kind: "raw",
            payload: mergeDefinedReplySemantics(duplicateBlockEntry.input.payload, payload),
          };
        } else if (matchingMediaBlockEntry?.input.kind === "raw") {
          matchingMediaBlockEntry.input = {
            kind: "raw",
            payload: mergeMediaReplySemantics(matchingMediaBlockEntry.input.payload, payload),
          };
        }
        const remainingFinalMediaUrls = matchingMediaBlockEntry ? [] : finalMediaUrls;
        if (
          remainingFinalMediaUrls.length === 0 &&
          ((duplicateBlockEntry && !hasUnmergedReplySemantics(payload)) ||
            (!duplicateBlockEntry && !finalDisplayText && !hasReplySemantics(payload)))
        ) {
          return [];
        }
        return [
          {
            ...entry,
            input: {
              kind: "raw" as const,
              payload: {
                ...payload,
                mediaUrl: undefined,
                mediaUrls: remainingFinalMediaUrls.length > 0 ? remainingFinalMediaUrls : undefined,
              },
            },
          },
        ];
      })
    : finalPayloadEntries;
  if (suppressReplies) {
    return [];
  }
  return [...commandBlockPayloadEntriesForDelivery, ...finalPayloadEntriesForDelivery].map(
    (entry) => entry.input,
  );
}
