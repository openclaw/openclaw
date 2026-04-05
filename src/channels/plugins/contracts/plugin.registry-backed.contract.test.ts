import { describe } from "vitest";
import { installChannelPluginContractSuite } from "../../../../test/helpers/channels/registry-contract-suites.js";
import { getPluginContractRegistry } from "./registry-plugin.js";

for (const entry of getPluginContractRegistry()) {
  describe(`${entry.id} plugin contract`, () => {
    installChannelPluginContractSuite({
      plugin: entry.plugin,
    });
  });
}
