import { bluebubblesPlugin } from "../../../extensions/bluebubbles/index.js";
import { discordPlugin, setDiscordRuntime } from "../../../extensions/discord/index.js";
import { discordSetupPlugin } from "../../../extensions/discord/setup-entry.js";
import { feishuPlugin } from "../../../extensions/feishu/index.js";
import { imessagePlugin } from "../../../extensions/imessage/index.js";
import { imessageSetupPlugin } from "../../../extensions/imessage/setup-entry.js";
import { ircPlugin } from "../../../extensions/irc/index.js";
import { linePlugin, setLineRuntime } from "../../../extensions/line/index.js";
import { lineSetupPlugin } from "../../../extensions/line/setup-entry.js";
import { mattermostPlugin } from "../../../extensions/mattermost/index.js";
import { nextcloudTalkPlugin } from "../../../extensions/nextcloud-talk/index.js";
import { signalPlugin } from "../../../extensions/signal/index.js";
import { signalSetupPlugin } from "../../../extensions/signal/setup-entry.js";
import { slackPlugin } from "../../../extensions/slack/index.js";
import { slackSetupPlugin } from "../../../extensions/slack/setup-entry.js";
import { synologyChatPlugin } from "../../../extensions/synology-chat/index.js";
import { telegramPlugin, setTelegramRuntime } from "../../../extensions/telegram/index.js";
import { telegramSetupPlugin } from "../../../extensions/telegram/setup-entry.js";
import { whatsappPlugin } from "../../../extensions/whatsapp/index.js";
import { whatsappSetupPlugin } from "../../../extensions/whatsapp/setup-entry.js";
import { zaloPlugin } from "../../../extensions/zalo/index.js";
import type { ChannelId, ChannelPlugin } from "./types.js";

export const bundledChannelPlugins = [
  bluebubblesPlugin,
  discordPlugin,
  feishuPlugin,
  imessagePlugin,
  ircPlugin,
  linePlugin,
  mattermostPlugin,
  nextcloudTalkPlugin,
  signalPlugin,
  slackPlugin,
  synologyChatPlugin,
  telegramPlugin,
  whatsappPlugin,
  zaloPlugin,
] as ChannelPlugin[];

export const bundledChannelSetupPlugins = [
  telegramSetupPlugin,
  whatsappSetupPlugin,
  discordSetupPlugin,
  ircPlugin,
  slackSetupPlugin,
  signalSetupPlugin,
  imessageSetupPlugin,
  lineSetupPlugin,
] as ChannelPlugin[];

const bundledChannelPluginsById = new Map(
  bundledChannelPlugins.map((plugin) => [plugin.id, plugin] as const),
);

export function getBundledChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  return bundledChannelPluginsById.get(id);
}

export function requireBundledChannelPlugin(id: ChannelId): ChannelPlugin {
  const plugin = getBundledChannelPlugin(id);
  if (!plugin) {
    throw new Error(`missing bundled channel plugin: ${id}`);
  }
  return plugin;
}

export const bundledChannelRuntimeSetters = {
  setDiscordRuntime,
  setLineRuntime,
  setTelegramRuntime,
};
