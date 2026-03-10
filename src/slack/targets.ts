import {
  buildMessagingTarget,
  ensureTargetId,
  parseMentionPrefixOrAtUserTarget,
  requireTargetKind,
  type MessagingTarget,
  type MessagingTargetKind,
  type MessagingTargetParseOptions,
} from "../channels/targets.js";

export type SlackTargetKind = MessagingTargetKind;

export type SlackTarget = MessagingTarget;
export type SlackRoutePeerKind = "direct" | "group" | "channel";

type SlackTargetParseOptions = MessagingTargetParseOptions;

function looksLikeSlackChannelId(value: string): boolean {
  return /^[CG][A-Z0-9]+$/i.test(value);
}

function looksLikeSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9]+$/i.test(value);
}

export function parseSlackTarget(
  raw: string,
  options: SlackTargetParseOptions = {},
): SlackTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const userTarget = parseMentionPrefixOrAtUserTarget({
    raw: trimmed,
    mentionPattern: /^<@([A-Z0-9]+)>$/i,
    prefixes: [
      { prefix: "user:", kind: "user" },
      { prefix: "channel:", kind: "channel" },
      { prefix: "slack:", kind: "user" },
    ],
    atUserPattern: /^[A-Z0-9]+$/i,
    atUserErrorMessage: "Slack DMs require a user id (use user:<id> or <@id>)",
  });
  if (userTarget) {
    return userTarget;
  }
  if (trimmed.startsWith("#")) {
    const candidate = trimmed.slice(1).trim();
    const id = ensureTargetId({
      candidate,
      pattern: /^[A-Z0-9]+$/i,
      errorMessage: "Slack channels require a channel id (use channel:<id>)",
    });
    return buildMessagingTarget("channel", id, trimmed);
  }
  if (options.defaultKind) {
    return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
  }
  return buildMessagingTarget("channel", trimmed, trimmed);
}

export function resolveSlackChannelId(raw: string): string {
  const target = parseSlackTarget(raw, { defaultKind: "channel" });
  return requireTargetKind({ platform: "Slack", target, kind: "channel" });
}

export function canonicalizeSlackRoutePeerId(params: { kind: SlackRoutePeerKind; raw: string }): {
  id: string;
  didNormalize: boolean;
  usedTargetSyntax: boolean;
} {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return { id: "", didNormalize: false, usedTargetSyntax: false };
  }

  if (params.kind === "direct") {
    const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
    if (mention?.[1]) {
      const id = mention[1].toUpperCase();
      return { id, didNormalize: id !== trimmed, usedTargetSyntax: true };
    }

    const prefixed = trimmed.match(/^(?:slack:|user:)([A-Z0-9]+)$/i);
    if (prefixed?.[1] && looksLikeSlackUserId(prefixed[1])) {
      const id = prefixed[1].toUpperCase();
      return { id, didNormalize: id !== trimmed, usedTargetSyntax: true };
    }

    if (looksLikeSlackUserId(trimmed)) {
      const id = trimmed.toUpperCase();
      return { id, didNormalize: id !== trimmed, usedTargetSyntax: false };
    }

    return { id: trimmed, didNormalize: false, usedTargetSyntax: false };
  }

  const channelMention = trimmed.match(/^<#([A-Z0-9]+)(?:\|[^>]+)?>$/i);
  if (channelMention?.[1]) {
    const id = channelMention[1].toUpperCase();
    return { id, didNormalize: id !== trimmed, usedTargetSyntax: true };
  }

  const channelPrefixed = trimmed.match(/^channel:([A-Z0-9]+)$/i);
  if (channelPrefixed?.[1] && looksLikeSlackChannelId(channelPrefixed[1])) {
    const id = channelPrefixed[1].toUpperCase();
    return { id, didNormalize: id !== trimmed, usedTargetSyntax: true };
  }

  const hashPrefixed = trimmed.match(/^#([A-Z0-9]+)$/i);
  if (hashPrefixed?.[1] && looksLikeSlackChannelId(hashPrefixed[1])) {
    const id = hashPrefixed[1].toUpperCase();
    return { id, didNormalize: id !== trimmed, usedTargetSyntax: true };
  }

  if (looksLikeSlackChannelId(trimmed)) {
    const id = trimmed.toUpperCase();
    return { id, didNormalize: id !== trimmed, usedTargetSyntax: false };
  }

  return { id: trimmed, didNormalize: false, usedTargetSyntax: false };
}
