import type { CommandArgs } from "../../auto-reply/commands-registry.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { buildUntrustedChannelMetadata } from "../../security/channel-metadata.js";
import {
  resolveDiscordOwnerAllowFrom,
  type DiscordChannelConfigResolved,
  type DiscordGuildEntryResolved,
} from "./allow-list.js";

export type BuildDiscordNativeCommandContextParams = {
  prompt: string;
  commandArgs: CommandArgs;
  sessionKey: string;
  commandTargetSessionKey: string;
  accountId?: string | null;
  interactionId: string;
  channelId: string;
  threadParentId?: string;
  guildName?: string;
  channelTopic?: string;
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  allowNameMatching?: boolean;
  commandAuthorized: boolean;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isGuild: boolean;
  isThreadChannel: boolean;
  user: {
    id: string;
    username: string;
    globalName?: string | null;
  };
  sender: {
    id: string;
    name?: string;
    tag?: string;
  };
  timestampMs?: number;
};

function buildDiscordNativeCommandSystemPrompt(
  channelConfig?: DiscordChannelConfigResolved | null,
): string | undefined {
  const systemPromptParts = [channelConfig?.systemPrompt?.trim() || null].filter(
    (entry): entry is string => Boolean(entry),
  );
  return systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
}

function buildDiscordNativeCommandUntrustedContext(params: {
  isGuild: boolean;
  channelTopic?: string;
}): string[] | undefined {
  if (!params.isGuild) {
    return undefined;
  }
  const untrustedChannelMetadata = buildUntrustedChannelMetadata({
    source: "discord",
    label: "Discord channel topic",
    entries: [params.channelTopic],
  });
  return untrustedChannelMetadata ? [untrustedChannelMetadata] : undefined;
}

export function buildDiscordNativeCommandContext(params: BuildDiscordNativeCommandContextParams) {
  const conversationLabel = params.isDirectMessage
    ? (params.user.globalName ?? params.user.username)
    : params.channelId;
  const ownerAllowFrom = resolveDiscordOwnerAllowFrom({
    channelConfig: params.channelConfig,
    guildInfo: params.guildInfo,
    sender: params.sender,
    allowNameMatching: params.allowNameMatching,
  });

  return finalizeInboundContext({
    Body: params.prompt,
    BodyForAgent: params.prompt,
    RawBody: params.prompt,
    CommandBody: params.prompt,
    CommandArgs: params.commandArgs,
    From: params.isDirectMessage
      ? `discord:${params.user.id}`
      : params.isGroupDm
        ? `discord:group:${params.channelId}`
        : `discord:channel:${params.channelId}`,
    To: `slash:${params.user.id}`,
    SessionKey: params.sessionKey,
    CommandTargetSessionKey: params.commandTargetSessionKey,
    AccountId: params.accountId ?? undefined,
    ChatType: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
    ConversationLabel: conversationLabel,
    GroupSubject: params.isGuild ? params.guildName : undefined,
    GroupSystemPrompt: params.isGuild
      ? buildDiscordNativeCommandSystemPrompt(params.channelConfig)
      : undefined,
    UntrustedContext: buildDiscordNativeCommandUntrustedContext({
      isGuild: params.isGuild,
      channelTopic: params.channelTopic,
    }),
    OwnerAllowFrom: ownerAllowFrom,
    SenderName: params.user.globalName ?? params.user.username,
    SenderId: params.user.id,
    SenderUsername: params.user.username,
    SenderTag: params.sender.tag,
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: true,
    MessageSid: params.interactionId,
    MessageThreadId: params.isThreadChannel ? params.channelId : undefined,
    Timestamp: params.timestampMs ?? Date.now(),
    CommandAuthorized: params.commandAuthorized,
    CommandSource: "native" as const,
    // Native slash contexts use To=slash:<user> for interaction routing.
    // For follow-up delivery (for example subagent completion announces),
    // preserve the real Discord target separately.
    OriginatingChannel: "discord" as const,
    OriginatingTo: params.isDirectMessage
      ? `user:${params.user.id}`
      : `channel:${params.channelId}`,
    ThreadParentId: params.isThreadChannel ? params.threadParentId : undefined,
  });
}
