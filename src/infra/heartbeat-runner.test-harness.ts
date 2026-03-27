import { beforeEach } from "vitest";
import { slackPlugin, setSlackRuntime } from "../../extensions/slack/test-api.js";
import { telegramPlugin, setTelegramRuntime } from "../../extensions/telegram/test-api.js";
import { whatsappPlugin, setWhatsAppRuntime } from "../../extensions/whatsapp/test-api.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";

const slackChannelPlugin = slackPlugin as unknown as ChannelPlugin;
const telegramChannelPlugin = telegramPlugin as unknown as ChannelPlugin;
const whatsappChannelPlugin = whatsappPlugin as unknown as ChannelPlugin;

export function installHeartbeatRunnerTestRuntime(params?: { includeSlack?: boolean }): void {
  beforeEach(() => {
    const runtime = createPluginRuntime();
    setTelegramRuntime(runtime);
    setWhatsAppRuntime(runtime);
    if (params?.includeSlack) {
      setSlackRuntime(runtime);
      setActivePluginRegistry(
        createTestRegistry([
          { pluginId: "slack", plugin: slackChannelPlugin, source: "test" },
          { pluginId: "whatsapp", plugin: whatsappChannelPlugin, source: "test" },
          { pluginId: "telegram", plugin: telegramChannelPlugin, source: "test" },
        ]),
      );
      return;
    }
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "whatsapp", plugin: whatsappChannelPlugin, source: "test" },
        { pluginId: "telegram", plugin: telegramChannelPlugin, source: "test" },
      ]),
    );
  });
}
