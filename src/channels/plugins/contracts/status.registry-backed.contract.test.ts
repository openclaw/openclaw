import { describe } from "vitest";
import { getStatusContractRegistry } from "./registry-setup-status.js";
import { installChannelStatusContractSuite } from "./suites.js";

for (const entry of getStatusContractRegistry()) {
  describe(`${entry.id} status contract`, () => {
    installChannelStatusContractSuite({
      plugin: entry.plugin,
      cases: entry.cases as never,
    });
  });
}
