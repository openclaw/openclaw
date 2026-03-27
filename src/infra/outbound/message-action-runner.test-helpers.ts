import { slackPlugin, setSlackRuntime } from "../../../extensions/slack/test-api.js";
import { telegramPlugin, setTelegramRuntime } from "../../../extensions/telegram/test-api.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

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
