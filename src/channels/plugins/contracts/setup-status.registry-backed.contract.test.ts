import { describe } from "vitest";
import { getSetupContractRegistry, getStatusContractRegistry } from "./registry.js";
import { installChannelSetupContractSuite, installChannelStatusContractSuite } from "./suites.js";

for (const entry of getSetupContractRegistry()) {
  describe(`${entry.id} setup contract`, () => {
    installChannelSetupContractSuite({
      plugin: entry.plugin,
      cases: entry.cases as never,
    });
  });
}

for (const entry of getStatusContractRegistry()) {
  describe(`${entry.id} status contract`, () => {
    installChannelStatusContractSuite({
      plugin: entry.plugin,
      cases: entry.cases as never,
    });
  });
}
