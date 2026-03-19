import { describe } from "vitest";
import { statusContractRegistry } from "./registry.js";
import { installChannelStatusContractSuite } from "./suites.js";

for (const entry of statusContractRegistry) {
  describe(`${entry.id} status contract`, () => {
    installChannelStatusContractSuite({
      plugin: entry.plugin,
      cases: entry.cases as never,
    });
  });
}
