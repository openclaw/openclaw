import { discordPlugin } from "../../extensions/discord/src/channel.js";
import { imessagePlugin } from "../../extensions/imessage/src/channel.js";
import { signalPlugin } from "../../extensions/signal/src/channel.js";
import { slackPlugin } from "../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { whatsappPlugin } from "../../extensions/whatsapp/src/channel.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import type { ChannelChoice } from "./onboard-types.js";
import { getChannelOnboardingAdapter } from "./onboarding/registry.js";
import type { ChannelOnboardingAdapter } from "./onboarding/types.js";

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

export function patchChannelOnboardingAdapter<K extends keyof ChannelOnboardingAdapter>(
  channel: ChannelChoice,
  patch: Pick<ChannelOnboardingAdapter, K>,
): () => void {
  const adapter = getChannelOnboardingAdapter(channel);
  if (!adapter) {
    throw new Error(`missing onboarding adapter for ${channel}`);
  }
  const keys = Object.keys(patch) as K[];
  const previous = {} as Pick<ChannelOnboardingAdapter, K>;
  for (const key of keys) {
    previous[key] = adapter[key];
    adapter[key] = patch[key];
  }
  return () => {
    for (const key of keys) {
      adapter[key] = previous[key];
    }
  };
}
