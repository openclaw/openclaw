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

const testPluginOverrides = new Map<string, () => ChannelPlugin>([
  ["googlechat", getGooglechatPlugin],
  ["matrix", getMatrixPlugin],
  ["msteams", getMSTeamsPlugin],
  ["nostr", getNostrPlugin],
  ["tlon", getTlonPlugin],
  ["whatsapp", getWhatsAppPlugin],
]);

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

function resolveChannelPluginsForTests(onlyPluginIds?: readonly string[]): ChannelPlugin[] {
  const scopedIds = onlyPluginIds ? new Set(onlyPluginIds) : null;
  const selectedPlugins = new Map<string, ChannelPlugin>();

  for (const plugin of listBundledChannelPlugins()) {
    if (scopedIds && !scopedIds.has(plugin.id)) {
      continue;
    }
    selectedPlugins.set(plugin.id, plugin);
  }

  for (const [pluginId, loadPlugin] of testPluginOverrides) {
    if (scopedIds && !scopedIds.has(pluginId)) {
      continue;
    }
    selectedPlugins.set(pluginId, loadPlugin());
  }

  return [...selectedPlugins.values()];
}

export function setChannelPluginRegistryForTests(onlyPluginIds?: readonly string[]): void {
  if (!onlyPluginIds || onlyPluginIds.includes("matrix")) {
    getSetMatrixRuntime()({
      state: {
        resolveStateDir: (_env, homeDir) => (homeDir ?? (() => "/tmp"))(),
      },
    } as Parameters<ReturnType<typeof getSetMatrixRuntime>>[0]);
  }

  const channels = resolveChannelPluginsForTests(onlyPluginIds).map((plugin) => ({
    pluginId: plugin.id,
    plugin,
    source: "test" as const,
  })) as unknown as Parameters<typeof createTestRegistry>[0];
  setActivePluginRegistry(createTestRegistry(channels));
}

export function setDefaultChannelPluginRegistryForTests(): void {
  setChannelPluginRegistryForTests();
}
