import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRuntime, type PluginRuntime } from "../../plugins/runtime/index.js";
import { loadBundledPluginTestApiSync } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

const { slackPlugin, setSlackRuntime } = loadBundledPluginTestApiSync<{
  slackPlugin: ChannelPlugin;
  setSlackRuntime: (runtime: PluginRuntime) => void;
}>("slack");
const { telegramPlugin, setTelegramRuntime } = loadBundledPluginTestApiSync<{
  telegramPlugin: ChannelPlugin;
  setTelegramRuntime: (runtime: PluginRuntime) => void;
}>("telegram");

export const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

export const telegramConfig = {
  channels: {
    telegram: {
      botToken: "telegram-test",
    },
  },
} as OpenClawConfig;

export function installMessageActionRunnerTestRegistry() {
  const runtime = createPluginRuntime();
  setSlackRuntime(runtime);
  setTelegramRuntime(runtime);
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        source: "test",
        plugin: slackPlugin,
      },
      {
        pluginId: "telegram",
        source: "test",
        plugin: telegramPlugin,
      },
    ]),
  );
}

export function resetMessageActionRunnerTestRegistry() {
  setActivePluginRegistry(createTestRegistry([]));
}
