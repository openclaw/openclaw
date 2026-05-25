import { resolveRuntimePolicySessionKey } from "../auto-reply/reply/runtime-policy-session-key.js";
import { normalizeChatType } from "../channels/chat-type.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

export function stripChannelRecipientPrefix(
  value: string | undefined,
  channel: string | undefined,
): string | undefined {
  const raw = normalizeOptionalString(value);
  const normalizedChannel = normalizeOptionalLowercaseString(channel);
  if (!raw || !normalizedChannel) {
    return raw;
  }
  const prefix = `${normalizedChannel}:`;
  if (!raw.toLowerCase().startsWith(prefix)) {
    return raw;
  }
  const stripped = raw.slice(prefix.length);
  const topicMarkerIndex = stripped.toLowerCase().indexOf(":topic:");
  return topicMarkerIndex >= 0 ? stripped.slice(0, topicMarkerIndex) : stripped;
}

export function resolveDisplayRuntimePolicySessionKey(params: {
  cfg: OpenClawConfig;
  key: string;
  entry?: SessionEntry | null;
}): string | undefined {
  const { cfg, entry, key } = params;
  if (!entry) {
    return undefined;
  }
  const origin = entry.origin;
  const deliveryContext = entry.deliveryContext;
  const chatType = normalizeChatType(origin?.chatType ?? entry.chatType);
  if (chatType !== "direct") {
    return undefined;
  }

  const channel = normalizeOptionalString(
    origin?.provider ??
      deliveryContext?.channel ??
      entry.lastChannel ??
      entry.channel ??
      origin?.surface,
  );
  const to = normalizeOptionalString(origin?.to ?? deliveryContext?.to ?? entry.lastTo);
  const from = normalizeOptionalString(origin?.from);
  const nativeDirectUserId = normalizeOptionalString(origin?.nativeDirectUserId);
  const peerId =
    nativeDirectUserId ??
    stripChannelRecipientPrefix(to, channel) ??
    stripChannelRecipientPrefix(from, channel);

  const runtimePolicySessionKey = resolveRuntimePolicySessionKey({
    cfg,
    sessionKey: key,
    ctx: {
      SessionKey: key,
      Provider: channel,
      Surface: normalizeOptionalString(origin?.surface),
      AccountId: normalizeOptionalString(
        origin?.accountId ?? deliveryContext?.accountId ?? entry.lastAccountId,
      ),
      ChatType: chatType,
      NativeDirectUserId: nativeDirectUserId,
      SenderId: peerId,
      OriginatingTo: to,
      From: from,
      To: to,
    },
  });

  return runtimePolicySessionKey && runtimePolicySessionKey !== key
    ? runtimePolicySessionKey
    : undefined;
}
