import { isMessagingToolDuplicate } from "../../agents/pi-embedded-helpers.js";
import type { MessagingToolSend } from "../../agents/pi-embedded-runner.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import { parseExplicitTargetForChannel } from "../../channels/plugins/target-parsing.js";
import { parseTelegramTarget } from "../../../extensions/telegram/api.js";
import { parseSlackTarget } from "../../../extensions/slack/api.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
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
    if (!trimmed.toLowerCase().startsWith("file://")) {
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
    return {
      ...payload,
      mediaUrl: stripSingle ? undefined : mediaUrl,
      mediaUrls: filteredUrls?.length ? filteredUrls : undefined,
    };
  });
}

const PROVIDER_ALIAS_MAP: Record<string, string> = {
  lark: "feishu",
};

function normalizeProviderForComparison(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = trimmed.toLowerCase();
  const normalizedChannel = normalizeChannelId(trimmed);
  if (normalizedChannel) {
    return normalizedChannel;
  }
  return PROVIDER_ALIAS_MAP[lowered] ?? lowered;
}

function normalizeThreadIdForComparison(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return String(Number.parseInt(trimmed, 10));
  }
  return trimmed.toLowerCase();
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

function parseBuiltinTarget(
  provider: string,
  raw: string,
): { to: string; threadId?: string } | null {
  if (provider === "telegram") {
    const result = parseTelegramTarget(raw);
    return {
      to: result.chatId,
      threadId: result.messageThreadId != null ? String(result.messageThreadId) : undefined,
    };
  }
  if (provider === "slack") {
    const result = parseSlackTarget(raw, { defaultKind: "channel" });
    if (!result) {
      return null;
    }
    return { to: result.id };
  }
  return null;
}

function targetsMatchForSuppression(params: {
  provider: string;
  originTarget: string;
  targetKey: string;
  targetThreadId?: string;
}): boolean {
  // Try plugin-based parsing first (handles all registered channels including Slack).
  const originPlugin = parseExplicitTargetForChannel(params.provider, params.originTarget);
  const targetPlugin = parseExplicitTargetForChannel(params.provider, params.targetKey);
  const origin = originPlugin
    ? { to: originPlugin.to, threadId: originPlugin.threadId != null ? String(originPlugin.threadId) : undefined }
    : parseBuiltinTarget(params.provider, params.originTarget);
  const target = targetPlugin
    ? { to: targetPlugin.to, threadId: targetPlugin.threadId != null ? String(targetPlugin.threadId) : undefined }
    : parseBuiltinTarget(params.provider, params.targetKey);
  if (!origin || !target) {
    return params.targetKey === params.originTarget;
  }
  if (origin.to.trim().toLowerCase() !== target.to.trim().toLowerCase()) {
    return false;
  }
  const explicitTargetThreadId = normalizeThreadIdForComparison(params.targetThreadId);
  const targetThreadId = explicitTargetThreadId ?? target.threadId;
  const originThreadId = origin.threadId;
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
  const originTarget = normalizeTargetForProvider(provider, params.originatingTo);
  if (!originTarget) {
    return false;
  }
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
    const targetKey = normalizeTargetForProvider(targetProvider, target.to);
    if (!targetKey) {
      return false;
    }
    const targetAccount = normalizeOptionalAccountId(target.accountId);
    if (originAccount && targetAccount && originAccount !== targetAccount) {
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
