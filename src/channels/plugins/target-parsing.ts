// Keep these imports on the narrow parser modules rather than the extension
// `api.ts` barrels. `parseExplicitTargetForChannel()` runs in core command /
// binding paths, so pulling the full extension export graphs here adds avoidable
// startup cost and can drag in optional channel-only deps too early.
import { parseDiscordTarget } from "../../../extensions/discord/src/targets.js";
import { parseMSTeamsExplicitTarget } from "../../../extensions/msteams/src/resolve-allowlist.js";
import { parseTelegramTarget } from "../../../extensions/telegram/src/targets.js";
import type { ChatType } from "../chat-type.js";
import { normalizeChatChannelId } from "../registry.js";
import { getChannelPlugin, normalizeChannelId } from "./registry.js";

export type ParsedChannelExplicitTarget = {
  to: string;
  threadId?: string | number;
  chatType?: ChatType;
};

function parseWithPlugin(
  rawChannel: string,
  rawTarget: string,
): ParsedChannelExplicitTarget | null {
  const channel = normalizeChatChannelId(rawChannel) ?? normalizeChannelId(rawChannel);
  if (!channel) {
    const normalized = rawChannel.trim().toLowerCase();
    if (normalized === "msteams" || normalized === "teams") {
      // Teams explicit-target parsing is needed in a few places before the
      // channel plugin registry is fully available. Keep this small fallback so
      // command/binding resolution can still normalize `teams:` / `msteams:`
      // targets consistently during early bootstrap and in tests.
      return parseMSTeamsExplicitTarget(rawTarget);
    }
    return null;
  }
  if (channel === "telegram") {
    const target = parseTelegramTarget(rawTarget);
    return {
      to: target.chatId,
      ...(target.messageThreadId != null ? { threadId: target.messageThreadId } : {}),
      ...(target.chatType === "unknown" ? {} : { chatType: target.chatType }),
    };
  }
  if (channel === "discord") {
    try {
      const target = parseDiscordTarget(rawTarget, { defaultKind: "channel" });
      if (!target) {
        return null;
      }
      return {
        to: target.id,
        chatType: target.kind === "user" ? "direct" : "channel",
      };
    } catch {
      // Discord's parser throws for malformed `@user`-style candidates. Keep
      // this helper nullable so callers can skip bad candidates instead of
      // aborting the whole command/binding resolution flow.
      return null;
    }
  }
  if (channel === "msteams") {
    return (
      // Prefer the registered Teams parser so target parsing follows the live
      // channel plugin contract like other channels. Keep the direct parser as a
      // fallback because Teams command/binding normalization is also used from
      // code paths that may run without a populated plugin registry.
      getChannelPlugin("msteams")?.messaging?.parseExplicitTarget?.({ raw: rawTarget }) ??
      parseMSTeamsExplicitTarget(rawTarget)
    );
  }
  return getChannelPlugin(channel)?.messaging?.parseExplicitTarget?.({ raw: rawTarget }) ?? null;
}

export function parseExplicitTargetForChannel(
  channel: string,
  rawTarget: string,
): ParsedChannelExplicitTarget | null {
  return parseWithPlugin(channel, rawTarget);
}
