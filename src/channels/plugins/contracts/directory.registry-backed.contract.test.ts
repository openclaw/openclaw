import { describe } from "vitest";
import { getDirectoryContractRegistry } from "./registry.js";
import { installChannelDirectoryContractSuite } from "./suites.js";

for (const entry of getDirectoryContractRegistry()) {
  describe(`${entry.id} directory contract`, () => {
    installChannelDirectoryContractSuite({
      plugin: entry.plugin,
      coverage: entry.coverage,
      cfg: entry.cfg,
      accountId: entry.accountId,
    });
  });
}
