import { afterEach, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { listActiveChannelSetupPlugins, listChannelSetupPlugins } from "./setup-registry.js";

afterEach(() => resetPluginRuntimeStateForTest());

it("drops blank ids, retains the first normalized id's plugin and applies channel ordering", () => {
  const first = createChannelTestPluginBase({ id: "zeta", label: "First" });
  const duplicate = createChannelTestPluginBase({ id: " zeta ", label: "Duplicate" });
  const blank = createChannelTestPluginBase({ id: " ", label: "Blank" });
  const alpha = createChannelTestPluginBase({ id: "alpha", label: "Alpha" });
  const registry = createEmptyPluginRegistry();
  registry.channelSetups = [first, duplicate, blank, alpha].map((plugin) => ({
    pluginId: plugin.id,
    source: "test",
    enabled: true,
    plugin,
  }));
  setActivePluginRegistry(registry);

  for (const list of [listActiveChannelSetupPlugins, listChannelSetupPlugins]) {
    const result = list();
    expect(result).toEqual([alpha, first]);
    expect(result[1]).toBe(first);
  }
});
