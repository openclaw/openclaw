import { afterEach, beforeEach } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

export const createDiscordRegistry = () =>
  createTestRegistry([
    {
      pluginId: "discord",
      plugin: createOutboundTestPlugin({ id: "discord", outbound: { deliveryMode: "direct" } }),
      source: "test",
    },
  ]);

export function installDiscordRegistryHooks() {
  beforeEach(() => {
    setActivePluginRegistry(createDiscordRegistry());
  });

  afterEach(() => {
    setActivePluginRegistry(createDiscordRegistry());
  });
}
