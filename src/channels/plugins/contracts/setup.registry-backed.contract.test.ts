import { describe } from "vitest";
import { getSetupContractRegistry } from "./registry-setup-status.js";
import { installChannelSetupContractSuite } from "./suites.js";

for (const entry of getSetupContractRegistry()) {
  describe(`${entry.id} setup contract`, () => {
    installChannelSetupContractSuite({
      plugin: entry.plugin,
      cases: entry.cases as never,
    });
  });
}
