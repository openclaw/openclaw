import { describe } from "vitest";
import { getPluginContractRegistry } from "./registry-plugin.js";
import { installChannelPluginContractSuite } from "./suites.js";

for (const entry of getPluginContractRegistry()) {
  describe(`${entry.id} plugin contract`, () => {
    installChannelPluginContractSuite({
      plugin: entry.plugin,
    });
  });
}
