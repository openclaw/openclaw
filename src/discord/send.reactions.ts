import { Routes } from "discord-api-types/v10";

import { loadConfig } from "../config/config.js";
import {
  buildReactionIdentifier,
  createDiscordClient,
  formatReactionEmoji,
  normalizeReactionEmoji,
  resolveDiscordRest,
} from "./send.shared.js";
import type { DiscordReactionSummary, DiscordReactOpts } from "./send.types.js";

export async function reactMessageDiscord(
  channelId: string,
  messageId: string,
  emoji: string,
  opts: DiscordReactOpts = {},
) {
  const cfg = loadConfig();
  const { rest, request } = createDiscordClient(opts, cfg);
  const encoded = normalizeReactionEmoji(emoji);
  await request(
    () => rest.put(Routes.channelMessageOwnReaction(channelId, messageId, encoded)),
    "react",
  );
  return { ok: true };
}

export async function removeReactionDiscord(
  channelId: string,
  messageId: string,
  emoji: string,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  const encoded = normalizeReactionEmoji(emoji);
  await rest.delete(Routes.channelMessageOwnReaction(channelId, messageId, encoded));
  return { ok: true };
}

export async function removeOwnReactionsDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts = {},
): Promise<{ ok: true; removed: string[] }> {
  const rest = resolveDiscordRest(opts);
  const message = (await rest.get(Routes.channelMessage(channelId, messageId))) as {
    reactions?: Array<{ emoji: { id?: string | null; name?: string | null } }>;
  };
  const identifiers = new Set<string>();
  for (const reaction of message.reactions ?? []) {
    const identifier = buildReactionIdentifier(reaction.emoji);
    if (identifier) identifiers.add(identifier);
  }
  if (identifiers.size === 0) return { ok: true, removed: [] };
  const removed: string[] = [];
  await Promise.allSettled(
    Array.from(identifiers, (identifier) => {
      removed.push(identifier);
      return rest.delete(
        Routes.channelMessageOwnReaction(channelId, messageId, normalizeReactionEmoji(identifier)),
      );
    }),
  );
  return { ok: true, removed };
}

export async function fetchReactionsDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts & { limit?: number } = {},
): Promise<DiscordReactionSummary[]> {
  const rest = resolveDiscordRest(opts);
  const message = (await rest.get(Routes.channelMessage(channelId, messageId))) as {
    reactions?: Array<{
      count: number;
      emoji: { id?: string | null; name?: string | null };
    }>;
  };
  const reactions = message.reactions ?? [];
  if (reactions.length === 0) return [];
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit)
      ? Math.min(Math.max(Math.floor(opts.limit), 1), 100)
      : 100;

  const summaries: DiscordReactionSummary[] = [];
  for (const reaction of reactions) {
    const identifier = buildReactionIdentifier(reaction.emoji);
    if (!identifier) continue;
    const encoded = encodeURIComponent(identifier);
    const users = (await rest.get(Routes.channelMessageReaction(channelId, messageId, encoded), {
      limit,
    })) as Array<{ id: string; username?: string; discriminator?: string }>;
    summaries.push({
      emoji: {
        id: reaction.emoji.id ?? null,
        name: reaction.emoji.name ?? null,
        raw: formatReactionEmoji(reaction.emoji),
      },
      count: reaction.count,
      users: users.map((user) => ({
        id: user.id,
        username: user.username,
        tag:
          user.username && user.discriminator
            ? `${user.username}#${user.discriminator}`
            : user.username,
      })),
    });
  }
  return summaries;
}

export { fetchChannelPermissionsDiscord } from "./send.permissions.js";
