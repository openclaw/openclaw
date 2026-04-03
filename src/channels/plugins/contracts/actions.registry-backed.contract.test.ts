import { describe } from "vitest";
import { installChannelActionsContractSuite } from "../../../../test/helpers/channels/registry-contract-suites.js";
import { getActionContractRegistry } from "./registry-actions.js";

for (const entry of getActionContractRegistry()) {
  describe(`${entry.id} actions contract`, () => {
    installChannelActionsContractSuite({
      plugin: entry.plugin,
      cases: entry.cases as never,
      unsupportedAction: entry.unsupportedAction as never,
    });
  });
}
