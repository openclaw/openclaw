import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  parseSessionDeliveryRoute,
  parseThreadSessionSuffix,
} from "../../../src/sessions/session-key-utils.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { formatSessionChannelLabel, resolveChannelSessionInfo } from "./session-display.ts";

export type SessionChannelPresentation = {
  channel: string;
  channelLabel: string;
  kind?: "direct" | "group" | "channel" | "thread" | "topic";
  topicId?: string;
  conversation?: string;
  address?: string;
  account?: string;
};

type SessionChannelRow = Pick<
  GatewaySessionRow,
  | "key"
  | "channel"
  | "chatType"
  | "origin"
  | "accountId"
  | "subject"
  | "groupChannel"
  | "space"
  | "deliveryContext"
>;

function directAddress(
  channel: string,
  origin: SessionChannelRow["origin"],
  routePeer?: string,
): string | undefined {
  const candidates = [origin?.nativeDirectUserId, origin?.from];
  // An opaque current identity (for example a WhatsApp LID) must not borrow an old phone route.
  if (!candidates.some((value) => normalizeOptionalString(value))) {
    candidates.push(routePeer);
  }
  for (const candidate of candidates) {
    let value = normalizeOptionalString(candidate);
    if (!value) {
      continue;
    }
    if (channel === "matrix") {
      value = value.replace(/^matrix:/i, "");
      if (/^@[^\s:]+:[^\s]+$/.test(value)) {
        return value;
      }
      continue;
    }
    if (channel === "whatsapp") {
      value = value.replace(/^whatsapp:/i, "");
      // WhatsApp phone JIDs are numbers; privacy LIDs and group JIDs are not.
      const phoneJid = value.match(/^(\d+)(?:@s\.whatsapp\.net)?$/i);
      if (phoneJid) {
        value = `+${phoneJid[1]}`;
      }
    } else if (channel === "signal") {
      value = value.replace(/^signal:/i, "");
    } else if (["imessage", "bluebubbles", "sms", "email"].includes(channel)) {
      value = value.replace(/^(?:imessage|bluebubbles|sms|auto|email):/i, "");
      if (/^[^\s@:]+@[^\s@:]+$/.test(value)) {
        return value;
      }
    } else {
      continue;
    }
    if (/^\+[1-9]\d{1,14}$/.test(value)) {
      return value;
    }
  }
  return undefined;
}

function conversationLabel(channel: string, rawLabel: string | undefined): string | undefined {
  let label = rawLabel;
  if (!label) {
    return undefined;
  }
  // These suffixes belong to the bundled ingress label producers, not user titles.
  if (channel === "discord") {
    label = label.replace(/ (?:user|channel) id:\d+$/, "");
  } else if (channel === "telegram") {
    label = label.replace(/(?:^| )id:-?\d+(?: topic:\d+)?$/, "");
    if (/^(?:id:unknown|group:-?\d+(?: topic:\d+)?)$/.test(label)) {
      return undefined;
    }
  } else if (channel === "signal") {
    label = label.replace(/ id:\S+$/, "");
  }
  return normalizeOptionalString(label);
}

export function resolveSessionChannelPresentation(
  row: SessionChannelRow,
): SessionChannelPresentation | undefined {
  const info = resolveChannelSessionInfo(row.key, row.channel);
  const channel = normalizeOptionalLowercaseString(info.channel);
  if (!info.channelSession || !channel) {
    return undefined;
  }
  const rowChannel = normalizeOptionalLowercaseString(row.channel);
  const originChannel = normalizeOptionalLowercaseString(
    row.origin?.provider ?? row.origin?.surface,
  );
  const metadataMatches =
    (!rowChannel || rowChannel === channel) && (!originChannel || originChannel === channel);
  const origin = metadataMatches ? row.origin : undefined;
  const delivery =
    normalizeOptionalLowercaseString(row.deliveryContext?.channel) === channel
      ? row.deliveryContext
      : undefined;
  const route = parseSessionDeliveryRoute(row.key);
  const keyKind =
    row.key.match(/^agent:[^:]+:[^:]+:(direct|dm|group|channel|thread):/)?.[1] ??
    row.key.match(/^agent:[^:]+:[^:]+:[^:]+:(direct|dm):/)?.[1];
  const chatType = metadataMatches ? (row.chatType ?? origin?.chatType) : undefined;
  let kind: SessionChannelPresentation["kind"] =
    chatType ??
    (keyKind === "dm"
      ? "direct"
      : keyKind === "direct" || keyKind === "group" || keyKind === "channel" || keyKind === "thread"
        ? keyKind
        : undefined);
  const threadId =
    origin?.threadId ??
    delivery?.threadId ??
    parseThreadSessionSuffix(row.key).threadId ??
    (channel === "telegram" ? row.key.match(/:topic:(\d+)$/u)?.[1] : undefined);
  const topicId =
    channel === "telegram" && threadId != null
      ? normalizeOptionalString(String(threadId))
      : undefined;
  if (threadId != null && String(threadId).trim()) {
    kind = channel === "telegram" ? "topic" : "thread";
  }
  const address =
    chatType === "direct" || kind === "direct"
      ? directAddress(
          channel,
          origin,
          route?.channel === channel && (route.peerKind === "direct" || route.peerKind === "dm")
            ? route.peerId
            : undefined,
        )
      : undefined;
  const label = conversationLabel(channel, normalizeOptionalString(origin?.label));
  const subject = metadataMatches ? normalizeOptionalString(row.subject) : undefined;
  const groupChannel = metadataMatches ? normalizeOptionalString(row.groupChannel) : undefined;
  let conversation =
    channel === "discord"
      ? (label ?? groupChannel ?? subject)
      : ((channel === "msteams" && /^(?:personal|groupChat|channel)$/.test(subject ?? "")
          ? undefined
          : subject) ??
        groupChannel ??
        label);
  if (
    conversation === address ||
    conversation === origin?.from ||
    conversation === origin?.to ||
    conversation === origin?.nativeChannelId
  ) {
    conversation = undefined;
  }
  const account =
    (!rowChannel || rowChannel === channel ? normalizeOptionalString(row.accountId) : undefined) ??
    normalizeOptionalString(delivery?.accountId) ??
    normalizeOptionalString(origin?.accountId);
  return {
    channel,
    channelLabel: formatSessionChannelLabel(channel),
    kind,
    topicId,
    conversation,
    address,
    account: account === "default" ? undefined : account,
  };
}
