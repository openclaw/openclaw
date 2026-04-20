import { isMessagingToolDuplicate } from "../../agents/pi-embedded-helpers.js";
import type { MessagingToolSend } from "../../agents/pi-embedded-messaging.types.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { ReplyPayload } from "../types.js";

export function filterMessagingToolDuplicates(params: {
  payloads: ReplyPayload[];
  sentTexts: string[];
}): ReplyPayload[] {
  const { payloads, sentTexts } = params;
  if (sentTexts.length === 0) {
    return payloads;
  }
  return payloads.filter((payload) => !isMessagingToolDuplicate(payload.text ?? "", sentTexts));
}

export function filterMessagingToolMediaDuplicates(params: {
  payloads: ReplyPayload[];
  sentMediaUrls: string[];
}): ReplyPayload[] {
  const normalizeMediaForDedupe = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("file://")) {
      return trimmed;
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "file:") {
        return decodeURIComponent(parsed.pathname || "");
      }
    } catch {
      // Keep fallback below for non-URL-like inputs.
    }
    return trimmed.replace(/^file:\/\//i, "");
  };

  const { payloads, sentMediaUrls } = params;
  if (sentMediaUrls.length === 0) {
    return payloads;
  }
  const sentSet = new Set(sentMediaUrls.map(normalizeMediaForDedupe).filter(Boolean));
  return payloads.map((payload) => {
    const mediaUrl = payload.mediaUrl;
    const mediaUrls = payload.mediaUrls;
    const stripSingle = mediaUrl && sentSet.has(normalizeMediaForDedupe(mediaUrl));
    const filteredUrls = mediaUrls?.filter((u) => !sentSet.has(normalizeMediaForDedupe(u)));
    if (!stripSingle && (!mediaUrls || filteredUrls?.length === mediaUrls.length)) {
      return payload;
    }
    return Object.assign({}, payload, {
      mediaUrl: stripSingle ? undefined : mediaUrl,
      mediaUrls: filteredUrls?.length ? filteredUrls : undefined,
    });
  });
}

const PROVIDER_ALIAS_MAP: Record<string, string> = {
  lark: "feishu",
};

function normalizeProviderForComparison(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  const normalizedChannel = normalizeAnyChannelId(trimmed);
  if (normalizedChannel) {
    return normalizedChannel;
  }
  return PROVIDER_ALIAS_MAP[lowered] ?? lowered;
}

function normalizeThreadIdForComparison(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return String(Number.parseInt(trimmed, 10));
  }
  return normalizeLowercaseStringOrEmpty(trimmed);
}

function resolveTargetProviderForComparison(params: {
  currentProvider: string;
  targetProvider?: string;
}): string {
  const targetProvider = normalizeProviderForComparison(params.targetProvider);
  if (!targetProvider || targetProvider === "message") {
    return params.currentProvider;
  }
  return targetProvider;
}

function targetsMatchForSuppression(params: {
  provider: string;
  originTarget: string;
  targetKey: string;
  targetThreadId?: string;
}): boolean {
  const pluginMatch = getChannelPlugin(params.provider)?.outbound?.targetsMatchForReplySuppression;
  if (pluginMatch) {
    return pluginMatch({
      originTarget: params.originTarget,
      targetKey: params.targetKey,
      targetThreadId: normalizeThreadIdForComparison(params.targetThreadId),
    });
  }
  if (params.provider === "telegram") {
    const parseFallbackTelegramTarget = (
      raw: string,
    ): { to: string; threadId?: string } | undefined => {
      const trimmed = raw.trim();
      if (!trimmed) {
        return undefined;
      }
      let normalized = trimmed;
      let hasProviderPrefix = false;
      while (true) {
        const withProviderRemoved = normalized
          .replace(/^(telegram|tg):/i, "")
          .trim()
          .replace(/^(telegram|tg):/i, "")
          .trim();
        if (withProviderRemoved !== normalized) {
          hasProviderPrefix = true;
          normalized = withProviderRemoved;
          continue;
        }
        if (hasProviderPrefix && /^group:/i.test(normalized)) {
          normalized = normalized.replace(/^group:/i, "").trim();
          continue;
        }
        break;
      }

      const topicMatch = /^(.+?):topic:(\d+)$/i.exec(normalized);
      if (topicMatch) {
        return {
          to: topicMatch[1].trim(),
          threadId: topicMatch[2],
        };
      }
      const colonMatch = /^(.+):(\d+)$/i.exec(normalized);
      if (colonMatch) {
        return {
          to: colonMatch[1].trim(),
          threadId: colonMatch[2],
        };
      }
      return { to: normalized.trim() };
    };

    const parsedOrigin = parseFallbackTelegramTarget(params.originTarget);
    const parsedTarget = parseFallbackTelegramTarget(params.targetKey);
    if (!parsedOrigin || !parsedTarget) {
      return params.targetKey === params.originTarget;
    }
    const explicitTargetThreadId = normalizeThreadIdForComparison(params.targetThreadId);
    const targetThreadId = explicitTargetThreadId ?? parsedTarget.threadId;
    const originThreadId = parsedOrigin.threadId;
    if (parsedOrigin.to.trim().toLowerCase() !== parsedTarget.to.trim().toLowerCase()) {
      return false;
    }
    if (originThreadId && targetThreadId != null) {
      return originThreadId === targetThreadId;
    }
    if (originThreadId && targetThreadId == null) {
      return false;
    }
    if (!originThreadId && targetThreadId != null) {
      return false;
    }
    return true;
  }
  return params.targetKey === params.originTarget;
}

export function shouldSuppressMessagingToolReplies(params: {
  messageProvider?: string;
  messagingToolSentTargets?: MessagingToolSend[];
  originatingTo?: string;
  accountId?: string;
}): boolean {
  const provider = normalizeProviderForComparison(params.messageProvider);
  if (!provider) {
    return false;
  }
  const originRawTarget = normalizeOptionalString(params.originatingTo);
  const originAccount = normalizeOptionalAccountId(params.accountId);
  const sentTargets = params.messagingToolSentTargets ?? [];
  if (sentTargets.length === 0) {
    return false;
  }
  return sentTargets.some((target) => {
    const targetProvider = resolveTargetProviderForComparison({
      currentProvider: provider,
      targetProvider: target?.provider,
    });
    if (targetProvider !== provider) {
      return false;
    }
    const targetAccount = normalizeOptionalAccountId(target.accountId);
    if (originAccount && targetAccount && originAccount !== targetAccount) {
      return false;
    }
    const targetRaw = normalizeOptionalString(target.to);
    if (originRawTarget && targetRaw === originRawTarget && !target.threadId) {
      return true;
    }
    const originTarget = normalizeTargetForProvider(provider, originRawTarget);
    if (!originTarget) {
      return false;
    }
    const targetKey = normalizeTargetForProvider(targetProvider, targetRaw);
    if (!targetKey) {
      return false;
    }
    return targetsMatchForSuppression({
      provider,
      originTarget,
      targetKey,
      targetThreadId: target.threadId,
    });
  });
}
