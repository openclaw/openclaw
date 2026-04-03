import { listBundledChannelPlugins } from "../channels/plugins/bundled.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/index.js";
import { loadBundledPluginTestApiSync } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";

let googlechatPluginCache: ChannelPlugin | undefined;
let matrixPluginCache: ChannelPlugin | undefined;
let setMatrixRuntimeCache: ((runtime: PluginRuntime) => void) | undefined;
let msteamsPluginCache: ChannelPlugin | undefined;
let nostrPluginCache: ChannelPlugin | undefined;
let tlonPluginCache: ChannelPlugin | undefined;
let whatsappPluginCache: ChannelPlugin | undefined;

function getGooglechatPlugin(): ChannelPlugin {
  if (!googlechatPluginCache) {
    ({ googlechatPlugin: googlechatPluginCache } = loadBundledPluginTestApiSync<{
      googlechatPlugin: ChannelPlugin;
    }>("googlechat"));
  }
  return googlechatPluginCache;
}

function getMatrixPlugin(): ChannelPlugin {
  if (!matrixPluginCache) {
    ({ matrixPlugin: matrixPluginCache, setMatrixRuntime: setMatrixRuntimeCache } =
      loadBundledPluginTestApiSync<{
        matrixPlugin: ChannelPlugin;
        setMatrixRuntime: (runtime: PluginRuntime) => void;
      }>("matrix"));
  }
  return matrixPluginCache;
}

function getSetMatrixRuntime(): (runtime: PluginRuntime) => void {
  if (!setMatrixRuntimeCache) {
    void getMatrixPlugin();
  }
  return setMatrixRuntimeCache!;
}

function getMSTeamsPlugin(): ChannelPlugin {
  if (!msteamsPluginCache) {
    ({ msteamsPlugin: msteamsPluginCache } = loadBundledPluginTestApiSync<{
      msteamsPlugin: ChannelPlugin;
    }>("msteams"));
  }
  return msteamsPluginCache;
}

function getNostrPlugin(): ChannelPlugin {
  if (!nostrPluginCache) {
    ({ nostrPlugin: nostrPluginCache } = loadBundledPluginTestApiSync<{
      nostrPlugin: ChannelPlugin;
    }>("nostr"));
  }
  return nostrPluginCache;
}

function getTlonPlugin(): ChannelPlugin {
  if (!tlonPluginCache) {
    ({ tlonPlugin: tlonPluginCache } = loadBundledPluginTestApiSync<{
      tlonPlugin: ChannelPlugin;
    }>("tlon"));
  }
  return tlonPluginCache;
}

function getWhatsAppPlugin(): ChannelPlugin {
  if (!whatsappPluginCache) {
    ({ whatsappPlugin: whatsappPluginCache } = loadBundledPluginTestApiSync<{
      whatsappPlugin: ChannelPlugin;
    }>("whatsapp"));
  }
  return whatsappPluginCache;
}

export function setDefaultChannelPluginRegistryForTests(): void {
  getSetMatrixRuntime()({
    state: {
      resolveStateDir: (_env, homeDir) => (homeDir ?? (() => "/tmp"))(),
    },
  } as Parameters<ReturnType<typeof getSetMatrixRuntime>>[0]);
  const channels = [
    ...listBundledChannelPlugins(),
    getMatrixPlugin(),
    getMSTeamsPlugin(),
    getNostrPlugin(),
    getTlonPlugin(),
    getGooglechatPlugin(),
    getWhatsAppPlugin(),
  ].map((plugin) => ({
    pluginId: plugin.id,
    plugin,
    source: "test" as const,
  })) as unknown as Parameters<typeof createTestRegistry>[0];
  setActivePluginRegistry(createTestRegistry(channels));
}
