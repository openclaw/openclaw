import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { MessagingToolSend } from "../../agents/pi-embedded-messaging.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { splitByReplyToTags } from "../../utils/directive-tags.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import {
  resolveOriginAccountId,
  resolveOriginMessageProvider,
  resolveOriginMessageTo,
} from "./origin-routing.js";
import { shouldSuppressReasoningPayload } from "./reply-payloads-base.js";
import {
  applyReplyThreading,
  filterMessagingToolDuplicates,
  filterMessagingToolMediaDuplicates,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads.js";
import { resolveReplyToMode } from "./reply-threading.js";

function resolveCollectedAutoReplyTargetIds(params: {
  replyToMode: ReturnType<typeof resolveReplyToMode>;
  collectedMessageIds?: string[];
}): Set<string> | undefined {
  if (params.replyToMode !== "auto") {
    return undefined;
  }
  return params.collectedMessageIds?.length ? new Set(params.collectedMessageIds) : undefined;
}

function assignMissingCollectedReplyIds(params: {
  payloads: ReplyPayload[];
  collectedMessageIds: string[];
}): ReplyPayload[] {
  const availableIds = [...params.collectedMessageIds];
  const seenExplicitIds = new Set<string>();

  for (const payload of params.payloads) {
    const explicitId = payload.replyToId;
    if (!explicitId || seenExplicitIds.has(explicitId)) {
      continue;
    }
    seenExplicitIds.add(explicitId);
    const availableIndex = availableIds.indexOf(explicitId);
    if (availableIndex >= 0) {
      availableIds.splice(availableIndex, 1);
    }
  }

  return params.payloads.map((payload) => {
    if (payload.replyToId) {
      return payload;
    }
    const fallbackId = availableIds.shift();
    return fallbackId
      ? {
          ...payload,
          replyToId: fallbackId,
          replyToCurrent: true,
        }
      : payload;
  });
}

function reconcileCollectedReplyTargets(params: {
  payloads: ReplyPayload[];
  collectedMessageIds: string[];
}): ReplyPayload[] {
  const remainingIds = [...params.collectedMessageIds];
  const keep = Array.from({ length: params.payloads.length }, () => false);

  const reserveId = (id: string) => {
    const index = remainingIds.indexOf(id);
    if (index < 0) {
      return false;
    }
    remainingIds.splice(index, 1);
    return true;
  };

  for (const [index, payload] of params.payloads.entries()) {
    if (payload.replyToTag !== true || !payload.replyToId) {
      continue;
    }
    if (reserveId(payload.replyToId)) {
      keep[index] = true;
    }
  }

  for (const [index, payload] of params.payloads.entries()) {
    if (keep[index] || !payload.replyToId) {
      continue;
    }
    if (reserveId(payload.replyToId)) {
      keep[index] = true;
    }
  }

  return params.payloads.map((payload, index) => {
    if (keep[index]) {
      return payload;
    }
    const fallbackId = remainingIds.shift();
    return fallbackId
      ? {
          ...payload,
          replyToId: fallbackId,
          replyToCurrent: true,
        }
      : {
          ...payload,
          replyToId: undefined,
          replyToCurrent: false,
        };
  });
}

export function resolveFollowupDeliveryPayloads(params: {
  cfg: OpenClawConfig;
  payloads: ReplyPayload[];
  messageProvider?: string;
  messageId?: string;
  collectedMessageIds?: string[];
  originatingAccountId?: string;
  originatingChannel?: string;
  originatingChatType?: string | null;
  originatingTo?: string;
  sentMediaUrls?: string[];
  sentTargets?: MessagingToolSend[];
  sentTexts?: string[];
}): ReplyPayload[] {
  const replyToChannel = resolveOriginMessageProvider({
    originatingChannel: params.originatingChannel,
    provider: params.messageProvider,
  }) as OriginatingChannelType | undefined;
  const replyToMode = resolveReplyToMode(
    params.cfg,
    replyToChannel,
    params.originatingAccountId,
    params.originatingChatType,
  );
  const collectedAutoReplyTargetIds = resolveCollectedAutoReplyTargetIds({
    replyToMode,
    collectedMessageIds: params.collectedMessageIds,
  });
  const sanitizedPayloads = params.payloads.flatMap((payload) => {
    const text = payload.text;
    if (!text || !text.includes("HEARTBEAT_OK")) {
      return [payload];
    }
    const stripped = stripHeartbeatToken(text, { mode: "message" });
    const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
    if (stripped.shouldSkip && !hasMedia) {
      return [];
    }
    return [{ ...payload, text: stripped.text }];
  });
  const nonReasoningPayloads = sanitizedPayloads.filter(
    (payload) => !shouldSuppressReasoningPayload(payload),
  );
  let didMultiTagSplit = false;
  const multiTagPayloads = nonReasoningPayloads
    .flatMap((payload) => {
      const text = payload.text;
      if (!text || !text.includes("[[")) {
        return [payload];
      }
      const segments = splitByReplyToTags(text);
      if (segments.length <= 1) {
        return [payload];
      }
      didMultiTagSplit = true;
      return segments.map((segment) => ({
        ...payload,
        text: segment.text,
        replyToId: segment.replyToId,
        replyToCurrent: segment.replyToCurrent,
      }));
    })
    .map((payload) => {
      if (!payload.replyToId || !collectedAutoReplyTargetIds) {
        return payload;
      }
      return collectedAutoReplyTargetIds.has(payload.replyToId)
        ? payload
        : {
            ...payload,
            replyToId: undefined,
            replyToCurrent: false,
          };
    });
  const hasCollectedMapping =
    replyToMode === "auto" &&
    params.collectedMessageIds &&
    multiTagPayloads.length === params.collectedMessageIds.length;
  const collectedPayloads = hasCollectedMapping
    ? assignMissingCollectedReplyIds({
        payloads: multiTagPayloads,
        collectedMessageIds: params.collectedMessageIds ?? [],
      })
    : multiTagPayloads;
  const hasMultipleExplicitTargets =
    collectedPayloads.filter((payload) => payload.replyToId).length > 1;
  const effectiveReplyToMode =
    replyToMode === "auto"
      ? hasCollectedMapping || didMultiTagSplit || hasMultipleExplicitTargets
        ? "all"
        : "first"
      : replyToMode;
  const threadingPayloads =
    effectiveReplyToMode === "first" && replyToMode === "auto" && params.messageId
      ? collectedPayloads.map((payload) =>
          payload.replyToId
            ? payload
            : {
                ...payload,
                replyToId: params.messageId,
                replyToCurrent: true,
              },
        )
      : collectedPayloads;
  const replyTaggedPayloads = applyReplyThreading({
    payloads: threadingPayloads,
    replyToMode: effectiveReplyToMode,
    replyToChannel,
    currentMessageId: params.messageId,
  });
  const validatedReplyTaggedPayloads =
    replyToMode === "auto" && collectedAutoReplyTargetIds
      ? reconcileCollectedReplyTargets({
          payloads: replyTaggedPayloads.map((payload) => {
            if (!payload.replyToId || collectedAutoReplyTargetIds.has(payload.replyToId)) {
              return payload;
            }
            return {
              ...payload,
              replyToId: undefined,
              replyToCurrent: false,
            };
          }),
          collectedMessageIds: [...collectedAutoReplyTargetIds],
        })
      : replyTaggedPayloads;
  const dedupedPayloads = filterMessagingToolDuplicates({
    payloads: validatedReplyTaggedPayloads,
    sentTexts: params.sentTexts ?? [],
  });
  const mediaFilteredPayloads = filterMessagingToolMediaDuplicates({
    payloads: dedupedPayloads,
    sentMediaUrls: params.sentMediaUrls ?? [],
  });
  const suppressMessagingToolReplies = shouldSuppressMessagingToolReplies({
    messageProvider: replyToChannel,
    messagingToolSentTargets: params.sentTargets,
    originatingTo: resolveOriginMessageTo({
      originatingTo: params.originatingTo,
    }),
    accountId: resolveOriginAccountId({
      originatingAccountId: params.originatingAccountId,
    }),
  });
  return suppressMessagingToolReplies ? [] : mediaFilteredPayloads;
}
