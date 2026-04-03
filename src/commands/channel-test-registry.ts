import { listBundledChannelPlugins } from "../channels/plugins/bundled.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/index.js";
import { loadBundledPluginTestApiSync } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";

const { googlechatPlugin } = loadBundledPluginTestApiSync<{
  googlechatPlugin: ChannelPlugin;
}>("googlechat");
const { matrixPlugin, setMatrixRuntime } = loadBundledPluginTestApiSync<{
  matrixPlugin: ChannelPlugin;
  setMatrixRuntime: (runtime: PluginRuntime) => void;
}>("matrix");
const { msteamsPlugin } = loadBundledPluginTestApiSync<{
  msteamsPlugin: ChannelPlugin;
}>("msteams");
const { nostrPlugin } = loadBundledPluginTestApiSync<{
  nostrPlugin: ChannelPlugin;
}>("nostr");
const { tlonPlugin } = loadBundledPluginTestApiSync<{
  tlonPlugin: ChannelPlugin;
}>("tlon");
const { whatsappPlugin } = loadBundledPluginTestApiSync<{
  whatsappPlugin: ChannelPlugin;
}>("whatsapp");

export function setDefaultChannelPluginRegistryForTests(): void {
  setMatrixRuntime({
    state: {
      resolveStateDir: (_env, homeDir) => (homeDir ?? (() => "/tmp"))(),
    },
  } as Parameters<typeof setMatrixRuntime>[0]);
  const channels = [
    ...listBundledChannelPlugins(),
    matrixPlugin,
    msteamsPlugin,
    nostrPlugin,
    tlonPlugin,
    googlechatPlugin,
    whatsappPlugin,
  ].map((plugin) => ({
    pluginId: plugin.id,
    plugin,
    source: "test" as const,
  })) as unknown as Parameters<typeof createTestRegistry>[0];
  setActivePluginRegistry(createTestRegistry(channels));
}
