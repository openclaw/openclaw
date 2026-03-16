import { describe } from "vitest";
import { pluginContractRegistry } from "./registry.js";
import { installChannelPluginContractSuite } from "./suites.js";

for (const entry of pluginContractRegistry) {
  describe(`${entry.id} plugin contract`, () => {
    installChannelPluginContractSuite({
      plugin: entry.plugin,
    });
  });
}
