import { afterEach, beforeEach } from "vitest";
import { discordPlugin } from "../../../extensions/discord/src/channel.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

export const createDiscordRegistry = () =>
  createTestRegistry([
    {
      pluginId: "discord",
      plugin: discordPlugin,
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
