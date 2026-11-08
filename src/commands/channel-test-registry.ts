// Test helper for installing bundled channel plugins into the active plugin registry.
import {
  listBundledChannelPlugins,
  setBundledChannelRuntime,
} from "../channels/plugins/bundled.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";

function createChannelTestRuntime(): PluginRuntime {
  return {
    state: {
      resolveStateDir: (_env, homeDir) => (homeDir ?? (() => "/tmp"))(),
    },
  } as PluginRuntime;
}

/** Reset the active plugin registry to bundled channel plugins for command tests. */
export function setDefaultChannelPluginRegistryForTests(): void {
  const plugins = listBundledChannelPlugins();
  const runtime = createChannelTestRuntime();
  for (const plugin of plugins) {
    try {
      setBundledChannelRuntime(plugin.id, runtime);
    } catch {
      // Most bundled channels do not need a runtime setter for contract tests.
    }
  }

  const channels = plugins.map((plugin) => ({
    pluginId: plugin.id,
    plugin,
    source: "test" as const,
  })) as unknown as Parameters<typeof createTestRegistry>[0];
  setActivePluginRegistry(createTestRegistry(channels));
}
