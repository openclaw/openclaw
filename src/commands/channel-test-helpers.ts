import { discordPlugin } from "../../extensions/discord/src/channel.js";
import { imessagePlugin } from "../../extensions/imessage/src/channel.js";
import { signalPlugin } from "../../extensions/signal/src/channel.js";
import { slackPlugin } from "../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { whatsappPlugin } from "../../extensions/whatsapp/src/channel.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { getChannelSetupFlowAdapter } from "./channel-setup/registry.js";
import type { ChannelSetupFlowAdapter } from "./channel-setup/types.js";
import type { ChannelChoice } from "./onboard-types.js";

type ChannelSetupFlowAdapterPatch = Partial<
  Pick<
    ChannelSetupFlowAdapter,
    "configure" | "configureInteractive" | "configureWhenConfigured" | "getStatus"
  >
>;

type PatchedSetupAdapterFields = {
  configure?: ChannelSetupFlowAdapter["configure"];
  configureInteractive?: ChannelSetupFlowAdapter["configureInteractive"];
  configureWhenConfigured?: ChannelSetupFlowAdapter["configureWhenConfigured"];
  getStatus?: ChannelSetupFlowAdapter["getStatus"];
};

export function setDefaultChannelPluginRegistryForTests(): void {
  const channels = [
    { pluginId: "discord", plugin: discordPlugin, source: "test" },
    { pluginId: "slack", plugin: slackPlugin, source: "test" },
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
    { pluginId: "signal", plugin: signalPlugin, source: "test" },
    { pluginId: "imessage", plugin: imessagePlugin, source: "test" },
  ] as unknown as Parameters<typeof createTestRegistry>[0];
  setActivePluginRegistry(createTestRegistry(channels));
}

export function patchChannelSetupFlowAdapter(
  channel: ChannelChoice,
  patch: ChannelSetupFlowAdapterPatch,
): () => void {
  const adapter = getChannelSetupFlowAdapter(channel);
  if (!adapter) {
    throw new Error(`missing setup adapter for ${channel}`);
  }

  const previous: PatchedSetupAdapterFields = {};

  if (Object.prototype.hasOwnProperty.call(patch, "getStatus")) {
    previous.getStatus = adapter.getStatus;
    adapter.getStatus = patch.getStatus ?? adapter.getStatus;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "configure")) {
    previous.configure = adapter.configure;
    adapter.configure = patch.configure ?? adapter.configure;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "configureInteractive")) {
    previous.configureInteractive = adapter.configureInteractive;
    adapter.configureInteractive = patch.configureInteractive;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "configureWhenConfigured")) {
    previous.configureWhenConfigured = adapter.configureWhenConfigured;
    adapter.configureWhenConfigured = patch.configureWhenConfigured;
  }

  return () => {
    if (Object.prototype.hasOwnProperty.call(patch, "getStatus")) {
      adapter.getStatus = previous.getStatus!;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "configure")) {
      adapter.configure = previous.configure!;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "configureInteractive")) {
      adapter.configureInteractive = previous.configureInteractive;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "configureWhenConfigured")) {
      adapter.configureWhenConfigured = previous.configureWhenConfigured;
    }
  };
}
