import { describe } from "vitest";
import { getActionContractRegistry } from "./registry-actions.js";
import { getPluginContractRegistry } from "./registry.js";
import { installChannelActionsContractSuite, installChannelPluginContractSuite } from "./suites.js";

for (const entry of getPluginContractRegistry()) {
  describe(`${entry.id} plugin contract`, () => {
    installChannelPluginContractSuite({
      plugin: entry.plugin,
    });
  });
}

for (const entry of getActionContractRegistry()) {
  describe(`${entry.id} actions contract`, () => {
    installChannelActionsContractSuite({
      plugin: entry.plugin,
      cases: entry.cases as never,
      unsupportedAction: entry.unsupportedAction as never,
    });
  });
}
