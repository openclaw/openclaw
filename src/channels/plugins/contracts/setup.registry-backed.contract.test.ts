import { describe } from "vitest";
import { installChannelSetupContractSuite } from "../../../../test/helpers/channels/registry-contract-suites.js";
import { getSetupContractRegistry } from "./registry-setup-status.js";

for (const entry of getSetupContractRegistry()) {
  describe(`${entry.id} setup contract`, () => {
    installChannelSetupContractSuite({
      plugin: entry.plugin,
      cases: entry.cases as never,
    });
  });
}
