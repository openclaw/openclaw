import type { DiscordSendResult } from "../../extensions/discord/api.js";
import { attachChannelToResult } from "./channel-send-result.js";

type DiscordSendOptionInput = {
  replyToId?: string | null;
  accountId?: string | null;
  silent?: boolean;
};

type DiscordSendMediaOptionInput = DiscordSendOptionInput & {
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
};

/** Build the common Discord send options from SDK-level reply payload fields. */
export function buildDiscordSendOptions(input: DiscordSendOptionInput) {
  return {
    verbose: false,
    replyTo: input.replyToId ?? undefined,
    accountId: input.accountId ?? undefined,
    silent: input.silent ?? undefined,
  };
}

/** Extend the base Discord send options with media-specific fields. */
export function buildDiscordSendMediaOptions(input: DiscordSendMediaOptionInput) {
  return {
    ...buildDiscordSendOptions(input),
    mediaUrl: input.mediaUrl,
    mediaLocalRoots: input.mediaLocalRoots,
  };
}

/** Stamp raw Discord send results with the channel id expected by shared outbound flows. */
export function tagDiscordChannelResult(result: DiscordSendResult) {
  return attachChannelToResult("discord", result);
}
