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
import type {
  ChannelConfigRuntimeSchema,
  ChannelConfigSchema,
} from "../channels/plugins/types.plugin.js";

type BundledChannelRuntimeMap = ReadonlyMap<string, ChannelConfigRuntimeSchema>;
type BundledChannelConfigSchemaMap = ReadonlyMap<string, ChannelConfigSchema>;

const bundledChannelSchemaEntries: ReadonlyArray<
  readonly [string, ChannelConfigSchema | undefined]
> = [
  ["bluebubbles", BlueBubblesChannelConfigSchema],
  ["discord", DiscordChannelConfigSchema],
  ["googlechat", GoogleChatChannelConfigSchema],
  ["imessage", IMessageChannelConfigSchema],
  ["irc", IrcChannelConfigSchema],
  ["msteams", MSTeamsChannelConfigSchema],
  ["signal", SignalChannelConfigSchema],
  ["slack", SlackChannelConfigSchema],
  ["telegram", TelegramChannelConfigSchema],
  ["whatsapp", WhatsAppChannelConfigSchema],
] as const;

const bundledChannelRuntimeMap = new Map<string, ChannelConfigRuntimeSchema>();
const bundledChannelConfigSchemaMap = new Map<string, ChannelConfigSchema>();
for (const [channelId, channelSchema] of bundledChannelSchemaEntries) {
  if (!channelSchema) {
    continue;
  }
  bundledChannelConfigSchemaMap.set(channelId, channelSchema);
  if (channelSchema.runtime) {
    bundledChannelRuntimeMap.set(channelId, channelSchema.runtime);
  }
}

export function getBundledChannelRuntimeMap(): BundledChannelRuntimeMap {
  return bundledChannelRuntimeMap;
}

export function getBundledChannelConfigSchemaMap(): BundledChannelConfigSchemaMap {
  return bundledChannelConfigSchemaMap;
}
