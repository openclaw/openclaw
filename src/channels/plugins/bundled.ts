import { bluebubblesPlugin } from "../../../extensions/bluebubbles/src/channel.js";
import { discordPlugin } from "../../../extensions/discord/src/channel.js";
import { discordSetupPlugin } from "../../../extensions/discord/src/channel.setup.js";
import { setDiscordRuntime } from "../../../extensions/discord/src/runtime.js";
import { feishuPlugin } from "../../../extensions/feishu/src/channel.js";
import { googlechatPlugin } from "../../../extensions/googlechat/src/channel.js";
import { imessagePlugin } from "../../../extensions/imessage/src/channel.js";
import { imessageSetupPlugin } from "../../../extensions/imessage/src/channel.setup.js";
import { ircPlugin } from "../../../extensions/irc/src/channel.js";
import { linePlugin } from "../../../extensions/line/src/channel.js";
import { lineSetupPlugin } from "../../../extensions/line/src/channel.setup.js";
import { setLineRuntime } from "../../../extensions/line/src/runtime.js";
import { matrixPlugin } from "../../../extensions/matrix/src/channel.js";
import { mattermostPlugin } from "../../../extensions/mattermost/src/channel.js";
import { msteamsPlugin } from "../../../extensions/msteams/src/channel.js";
import { nextcloudTalkPlugin } from "../../../extensions/nextcloud-talk/src/channel.js";
import { nostrPlugin } from "../../../extensions/nostr/src/channel.js";
import { signalPlugin } from "../../../extensions/signal/src/channel.js";
import { signalSetupPlugin } from "../../../extensions/signal/src/channel.setup.js";
import { slackPlugin } from "../../../extensions/slack/src/channel.js";
import { slackSetupPlugin } from "../../../extensions/slack/src/channel.setup.js";
import { synologyChatPlugin } from "../../../extensions/synology-chat/src/channel.js";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { telegramSetupPlugin } from "../../../extensions/telegram/src/channel.setup.js";
import { setTelegramRuntime } from "../../../extensions/telegram/src/runtime.js";
import { tlonPlugin } from "../../../extensions/tlon/src/channel.js";
import { whatsappPlugin } from "../../../extensions/whatsapp/src/channel.js";
import { whatsappSetupPlugin } from "../../../extensions/whatsapp/src/channel.setup.js";
import { zaloPlugin } from "../../../extensions/zalo/src/channel.js";
import { zalouserPlugin } from "../../../extensions/zalouser/src/channel.js";
import type { ChannelId, ChannelPlugin } from "./types.js";

export const bundledChannelPlugins = [
  bluebubblesPlugin,
  discordPlugin,
  feishuPlugin,
  googlechatPlugin,
  imessagePlugin,
  ircPlugin,
  linePlugin,
  matrixPlugin,
  mattermostPlugin,
  msteamsPlugin,
  nextcloudTalkPlugin,
  nostrPlugin,
  signalPlugin,
  slackPlugin,
  synologyChatPlugin,
  telegramPlugin,
  tlonPlugin,
  whatsappPlugin,
  zaloPlugin,
  zalouserPlugin,
] as ChannelPlugin[];

export const bundledChannelSetupPlugins = [
  telegramSetupPlugin,
  whatsappSetupPlugin,
  discordSetupPlugin,
  ircPlugin,
  googlechatPlugin,
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
