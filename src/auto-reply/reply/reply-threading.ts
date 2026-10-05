/** Reply threading policy helpers for channel replies and status notices. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../channels/chat-type.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { getLoadedChannelThreadingAdapter } from "../../channels/thread-addressing.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/account-id.js";
import { resolveChannelAccountEntry } from "../../routing/account-lookup.js";
import {
  copyReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  setReplyPayloadMetadata,
  type ReplyDeliveryContext,
} from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload, ReplyThreadingPolicy } from "../types.js";
import { isSingleUseReplyToMode } from "./reply-reference.js";

type ReplyToModeChannelConfig = {
  replyToMode?: ReplyToMode;
  replyToModeByChatType?: Partial<Record<"direct" | "group" | "channel", ReplyToMode>>;
  accounts?: Record<string, ReplyToModeChannelConfig | undefined>;
};

function normalizeReplyToModeChatType(
  chatType?: string | null,
): "direct" | "group" | "channel" | undefined {
  return chatType === "direct" || chatType === "group" || chatType === "channel"
    ? chatType
    : undefined;
}

/** Resolve configured reply-to mode from channel and chat-type config. */
function resolveConfiguredReplyToMode(
  cfg: OpenClawConfig,
  provider?: string,
  chatType?: string | null,
  accountId?: string,
): ReplyToMode {
  if (!provider) {
    return "all";
  }
  const channelConfig = (cfg.channels as Record<string, ReplyToModeChannelConfig> | undefined)?.[
    provider
  ];
  const accountConfig = accountId
    ? resolveChannelAccountEntry(
        channelConfig?.accounts,
        normalizeAccountId(accountId),
        provider,
        normalizeAccountId,
      )
    : undefined;
  const normalizedChatType = normalizeReplyToModeChatType(chatType);
  if (normalizedChatType) {
    // Exhaust account policy before channel defaults so a routed account cannot silently inherit.
    return (
      accountConfig?.replyToModeByChatType?.[normalizedChatType] ??
      accountConfig?.replyToMode ??
      channelConfig?.replyToModeByChatType?.[normalizedChatType] ??
      channelConfig?.replyToMode ??
      "all"
    );
  }
  return accountConfig?.replyToMode ?? channelConfig?.replyToMode ?? "all";
}

/** Resolve effective reply-to mode for a channel/account/chat tuple. */
export function resolveReplyToMode(
  cfg: OpenClawConfig,
  channel?: OriginatingChannelType,
  accountId?: string | null,
  chatType?: string | null,
): ReplyToMode {
  const normalizedAccountId = normalizeOptionalLowercaseString(accountId);
  const provider = normalizeAnyChannelId(channel) ?? normalizeOptionalLowercaseString(channel);
  const threading =
    normalizedAccountId && provider ? getChannelPlugin(provider)?.threading : undefined;
  return (
    threading?.resolveReplyToMode?.({ cfg, accountId: normalizedAccountId, chatType }) ??
    resolveConfiguredReplyToMode(cfg, provider, chatType, normalizedAccountId)
  );
}

/** Resolve the account that routed reply delivery will use when none is explicit. */
export function resolveReplyDeliveryAccountId(
  cfg: OpenClawConfig,
  channel?: OriginatingChannelType,
  accountId?: string | null,
): string | undefined {
  const explicitAccountId = normalizeOptionalLowercaseString(accountId);
  if (explicitAccountId) {
    return explicitAccountId;
  }
  const provider = normalizeAnyChannelId(channel) ?? normalizeOptionalLowercaseString(channel);
  if (!provider) {
    return undefined;
  }
  const plugin = getChannelPlugin(provider);
  if (!plugin) {
    return undefined;
  }
  const configuredDefault = normalizeOptionalLowercaseString(plugin.config.defaultAccountId?.(cfg));
  if (configuredDefault) {
    return configuredDefault;
  }
  const channelConfiguredDefault = normalizeOptionalLowercaseString(
    (cfg.channels as Record<string, { defaultAccount?: string | null } | undefined> | undefined)?.[
      provider
    ]?.defaultAccount,
  );
  if (channelConfiguredDefault) {
    return channelConfiguredDefault;
  }
  const listedDefault = plugin.config
    .listAccountIds(cfg)
    .map((listedAccountId) => normalizeOptionalLowercaseString(listedAccountId))
    .find((listedAccountId): listedAccountId is string => Boolean(listedAccountId));
  return listedDefault ?? DEFAULT_ACCOUNT_ID;
}

/** Build the canonical reply policy context consumed by delivery adapters. */
export function createReplyDeliveryContext(
  replyToMode: ReplyToMode,
  chatType?: string | null,
): ReplyDeliveryContext {
  const normalizedChatType = normalizeChatType(chatType ?? undefined);
  return {
    ...(normalizedChatType ? { chatType: normalizedChatType } : {}),
    replyToMode,
  };
}

function suppressReplyTarget(payload: ReplyPayload): ReplyPayload {
  return setReplyPayloadMetadata(
    copyReplyPayloadMetadata(payload, {
      ...payload,
      replyToId: undefined,
      replyToCurrent: false,
      replyToTag: false,
    }),
    { replyTargetSuppressed: true },
  );
}

/** Create a reply-to filter using channel-specific explicit-tag defaults. */
export function createReplyToModeFilterForChannel(
  mode: ReplyToMode,
  channel?: OriginatingChannelType,
) {
  const normalized = normalizeOptionalLowercaseString(channel);
  const adapter = getLoadedChannelThreadingAdapter(normalized);
  // Named channels allow explicit tags even when their plugin is not loaded.
  const allowExplicitReplyTagsWhenOff =
    adapter?.allowExplicitReplyTagsWhenOff ?? adapter?.allowTagsWhenOff ?? Boolean(normalized);
  let hasThreaded = false;
  const apply = (payload: ReplyPayload, preview = false): ReplyPayload => {
    const isStatusNotice = isReplyPayloadStatusNotice(payload);
    if (!payload.replyToId) {
      return payload;
    }
    if (mode === "off") {
      const isExplicit = Boolean(payload.replyToTag) || Boolean(payload.replyToCurrent);
      // Explicit tags cannot override off-mode for transient status notices.
      if (allowExplicitReplyTagsWhenOff && isExplicit && !isStatusNotice) {
        return payload;
      }
      return copyReplyPayloadMetadata(payload, {
        ...payload,
        replyToId: undefined,
        replyToCurrent: payload.replyToCurrent === true ? false : payload.replyToCurrent,
      });
    }
    if (mode === "all") {
      return payload;
    }
    // Status notices keep their target without consuming the first-reply slot.
    if (isSingleUseReplyToMode(mode) && !isStatusNotice) {
      if (hasThreaded) {
        return suppressReplyTarget(payload);
      }
      if (!preview) {
        hasThreaded = true;
      }
    }
    return payload;
  };
  // Dedupe must inspect the actual transport route without spending a first-reply slot.
  return Object.assign((payload: ReplyPayload) => apply(payload), {
    preview: (payload: ReplyPayload) => apply(payload, true),
  });
}

/** Resolve whether implicit current-message replies are allowed under threading policy. */
export function resolveImplicitCurrentMessageReplyAllowance(
  mode: ReplyToMode | undefined,
  policy?: ReplyThreadingPolicy,
): boolean {
  const implicitCurrentMessage = policy?.implicitCurrentMessage ?? "default";
  return (
    implicitCurrentMessage === "allow" || (implicitCurrentMessage !== "deny" && mode !== "batched")
  );
}

/** Build threading policy for batched reply-to mode. */
export function resolveBatchedReplyThreadingPolicy(
  mode: ReplyToMode,
  isBatched: boolean,
): ReplyThreadingPolicy | undefined {
  if (mode !== "batched") {
    return undefined;
  }
  return {
    implicitCurrentMessage: isBatched ? "allow" : "deny",
  };
}
