import { BlueBubblesChannelConfigSchema } from "../../extensions/bluebubbles/channel-config-api.js";
import { DiscordChannelConfigSchema } from "../../extensions/discord/channel-config-api.js";
import { GoogleChatChannelConfigSchema } from "../../extensions/googlechat/channel-config-api.js";
import { IMessageChannelConfigSchema } from "../../extensions/imessage/channel-config-api.js";
import { IrcChannelConfigSchema } from "../../extensions/irc/channel-config-api.js";
import { MSTeamsChannelConfigSchema } from "../../extensions/msteams/channel-config-api.js";
import { SignalChannelConfigSchema } from "../../extensions/signal/channel-config-api.js";
import { SlackChannelConfigSchema } from "../../extensions/slack/channel-config-api.js";
import { TelegramChannelConfigSchema } from "../../extensions/telegram/channel-config-api.js";
import { WhatsAppChannelConfigSchema } from "../../extensions/whatsapp/channel-config-api.js";
import type { ChannelConfigRuntimeSchema } from "../channels/plugins/types.plugin.js";

type BundledChannelRuntimeMap = ReadonlyMap<string, ChannelConfigRuntimeSchema>;

const bundledChannelRuntimeEntries: ReadonlyArray<
  readonly [string, ChannelConfigRuntimeSchema | undefined]
> = [
  ["bluebubbles", BlueBubblesChannelConfigSchema.runtime],
  ["discord", DiscordChannelConfigSchema.runtime],
  ["googlechat", GoogleChatChannelConfigSchema.runtime],
  ["imessage", IMessageChannelConfigSchema.runtime],
  ["irc", IrcChannelConfigSchema.runtime],
  ["msteams", MSTeamsChannelConfigSchema.runtime],
  ["signal", SignalChannelConfigSchema.runtime],
  ["slack", SlackChannelConfigSchema.runtime],
  ["telegram", TelegramChannelConfigSchema.runtime],
  ["whatsapp", WhatsAppChannelConfigSchema.runtime],
] as const;

const bundledChannelRuntimeMap = new Map<string, ChannelConfigRuntimeSchema>();
for (const [channelId, runtimeSchema] of bundledChannelRuntimeEntries) {
  if (!runtimeSchema) {
    continue;
  }
  bundledChannelRuntimeMap.set(channelId, runtimeSchema);
}

export function getBundledChannelRuntimeMap(): BundledChannelRuntimeMap {
  return bundledChannelRuntimeMap;
}
