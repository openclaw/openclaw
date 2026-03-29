import { beforeEach } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime, type PluginRuntime } from "../plugins/runtime/index.js";
import { loadBundledPluginTestApiSync } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";

const { slackPlugin, setSlackRuntime } = loadBundledPluginTestApiSync<{
  slackPlugin: ChannelPlugin;
  setSlackRuntime: (runtime: PluginRuntime) => void;
}>("slack");
const { telegramPlugin, setTelegramRuntime } = loadBundledPluginTestApiSync<{
  telegramPlugin: ChannelPlugin;
  setTelegramRuntime: (runtime: PluginRuntime) => void;
}>("telegram");
const { whatsappPlugin, setWhatsAppRuntime } = loadBundledPluginTestApiSync<{
  whatsappPlugin: ChannelPlugin;
  setWhatsAppRuntime: (runtime: PluginRuntime) => void;
}>("whatsapp");

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
