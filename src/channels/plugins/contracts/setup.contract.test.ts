import { describe } from "vitest";
import { setupContractRegistry } from "./registry.js";
import { installChannelSetupContractSuite } from "./suites.js";

for (const entry of setupContractRegistry) {
  describe(`${entry.id} setup contract`, () => {
    installChannelSetupContractSuite({
      plugin: entry.plugin,
      cases: entry.cases as never,
    });
  });
}
