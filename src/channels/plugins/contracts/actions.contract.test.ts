import { describe } from "vitest";
import { actionContractRegistry } from "./registry.js";
import { installChannelActionsContractSuite } from "./suites.js";

for (const entry of actionContractRegistry) {
  describe(`${entry.id} actions contract`, () => {
    installChannelActionsContractSuite({
      plugin: entry.plugin,
      cases: entry.cases as never,
      unsupportedAction: entry.unsupportedAction as never,
    });
  });
}
