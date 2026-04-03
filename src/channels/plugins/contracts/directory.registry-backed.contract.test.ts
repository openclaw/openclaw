import { describe } from "vitest";
import { installChannelDirectoryContractSuite } from "../../../../test/helpers/channels/threading-directory-contract-suites.js";
import { getDirectoryContractRegistry } from "./registry.js";

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
