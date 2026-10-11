import { normalizeOptionalStringifiedId } from "@openclaw/normalization-core/string-coerce";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { PreparedMessageToolCatalog } from "../../channels/plugins/message-action-discovery.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { resolveActionDeliveryTargetAlias } from "../../infra/outbound/message-action-spec.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { readToolStringParam } from "./common.js";

const POLL_VOTE_ECHO_TTL_MS = 30_000;

// Share route-checked poll votes across runs in the same conversation: the poll
// and its following comment can arrive at different tool instances.
const recentPollVoteBySession = new Map<
  string,
  { option: string; route: string; recordedAt: number }
>();

export function suppressPollVoteEcho(
  sessionKey: string | undefined,
  route: string | undefined,
  action: ChannelMessageActionName,
  args: Record<string, unknown>,
): boolean {
  const vote = sessionKey ? recentPollVoteBySession.get(sessionKey) : undefined;
  if (!vote || !sessionKey || (action !== "send" && action !== "reply")) {
    return false;
  }
  const expired = Date.now() - vote.recordedAt >= POLL_VOTE_ECHO_TTL_MS;
  if (!expired && route !== vote.route) {
    return false;
  }
  recentPollVoteBySession.delete(sessionKey);
  if (expired) {
    return false;
  }
  const outboundText =
    readToolStringParam(args, "text") ??
    readToolStringParam(args, "message") ??
    readToolStringParam(args, "content");
  return Boolean(outboundText && isPollVoteEchoText(vote.option, outboundText));
}

export function recordPollVote(sessionKey: string, route: string, votedOption: unknown): void {
  const option = typeof votedOption === "string" ? votedOption.trim() : "";
  if (!option) {
    return;
  }
  const recordedAt = Date.now();
  // Prune on writes, including sessions that never send a follow-up text.
  for (const [key, entry] of recentPollVoteBySession) {
    if (recordedAt - entry.recordedAt >= POLL_VOTE_ECHO_TTL_MS) {
      recentPollVoteBySession.delete(key);
    }
  }
  recentPollVoteBySession.set(sessionKey, { option, route, recordedAt });
}

type NormalizedPollEchoText = {
  emojiSignature: string;
  words: string;
};

// Keep the emoji identity while ignoring where it appears. Messages stores poll
// options with a trailing emoji, while models commonly restate the same emoji
// before the label. Retaining the signature avoids collapsing distinct options.
const POLL_ECHO_EMOJI_SEQUENCE =
  /(?:[0-9#*]\u{FE0F}?\u{20E3}|(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}]|\u{FE0E}|\u{FE0F}|\u{200D})+)/gu;

function normalizePollEchoText(text: string): NormalizedPollEchoText {
  let emojiSignature = "";
  const words = text
    .replace(POLL_ECHO_EMOJI_SEQUENCE, (emoji) => {
      emojiSignature += emoji.replace(/[\u{FE0E}\u{FE0F}]/gu, "");
      return " ";
    })
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?]+$/u, "")
    .trim()
    .toLowerCase();
  return { emojiSignature, words };
}

function isPollVoteEchoText(option: string, outboundText: string): boolean {
  const normalizedOption = normalizePollEchoText(option);
  const normalizedOutbound = normalizePollEchoText(outboundText);
  const optionHasContent = Boolean(normalizedOption.words || normalizedOption.emojiSignature);
  if (!optionHasContent || normalizedOption.words !== normalizedOutbound.words) {
    return false;
  }
  if (normalizedOption.emojiSignature && normalizedOutbound.emojiSignature) {
    return normalizedOption.emojiSignature === normalizedOutbound.emojiSignature;
  }
  // A model may add or omit a decorative emoji around a word label. Emoji-only
  // options still require an exact signature so unrelated symbols never match.
  return Boolean(normalizedOption.words);
}

export function resolvePollVoteEchoRoute(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  channel?: string | null;
  accountId?: string;
  currentChannelId?: string;
  currentMessagingTarget?: string;
  preparedMessageToolCatalog?: PreparedMessageToolCatalog;
}): string | undefined {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel) {
    return undefined;
  }
  let deliveryAliasTarget: string | undefined;
  try {
    const selectedChannel = params.preparedMessageToolCatalog
      ? params.preparedMessageToolCatalog.getChannel(channel)
      : getChannelPlugin(channel);
    deliveryAliasTarget = resolveActionDeliveryTargetAlias(params.action, params.args, {
      channel,
      aliasSpec:
        params.preparedMessageToolCatalog || selectedChannel
          ? (selectedChannel?.actions?.messageActionTargetAliases?.[params.action] ?? null)
          : undefined,
    });
  } catch {
    return undefined;
  }
  const targets = ["target", "to", "channelId"]
    .map((key) => normalizeOptionalStringifiedId(params.args[key]))
    .concat(deliveryAliasTarget ?? [])
    .filter((value): value is string => Boolean(value));
  if (new Set(targets).size > 1) {
    return undefined;
  }
  const target = targets[0];
  const currentTargets = new Set(
    [params.currentMessagingTarget, params.currentChannelId].filter((value): value is string =>
      Boolean(value),
    ),
  );
  // Plugin-declared aliases keep owner-specific target fields out of core.
  // A route mismatch fails open; provider/account keys prevent cross-send suppression.
  const routeTarget = !target || currentTargets.has(target) ? "<current-source>" : target;
  return `${channel}\0${normalizeAccountId(params.accountId ?? "default")}\0${routeTarget}`;
}
