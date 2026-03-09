import type { DiscordSendResult } from "../discord/send.types.js";

type DiscordSendOptionInput = {
  replyToId?: string | null;
  accountId?: string | null;
  silent?: boolean;
};

type DiscordSendMediaOptionInput = DiscordSendOptionInput & {
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
};

export function buildDiscordSendOptions(input: DiscordSendOptionInput) {
  return {
    verbose: false,
    replyTo: input.replyToId ?? undefined,
    accountId: input.accountId ?? undefined,
    silent: input.silent ?? undefined,
  };
}

export function buildDiscordSendMediaOptions(input: DiscordSendMediaOptionInput) {
  return {
    ...buildDiscordSendOptions(input),
    mediaUrl: input.mediaUrl,
    mediaLocalRoots: input.mediaLocalRoots,
  };
}

export function tagDiscordChannelResult(result: DiscordSendResult) {
  return { channel: "discord" as const, ...result };
}
