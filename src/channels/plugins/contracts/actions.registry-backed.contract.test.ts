import { describe } from "vitest";
import { getActionContractRegistry } from "./registry-actions.js";
import { installChannelActionsContractSuite } from "./suites.js";

for (const entry of getActionContractRegistry()) {
  describe(`${entry.id} actions contract`, () => {
    installChannelActionsContractSuite({
      plugin: entry.plugin,
      cases: entry.cases as never,
      unsupportedAction: entry.unsupportedAction as never,
    });
  });
}
