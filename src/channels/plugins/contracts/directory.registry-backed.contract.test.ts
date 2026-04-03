import { describe } from "vitest";
import { getDirectoryContractRegistry } from "../../../../test/helpers/channels/surface-contract-registry.js";
import { installChannelDirectoryContractSuite } from "../../../../test/helpers/channels/threading-directory-contract-suites.js";

for (const entry of getDirectoryContractRegistry()) {
  describe(`${entry.id} directory contract`, () => {
    installChannelDirectoryContractSuite({
      plugin: entry.plugin,
      coverage: entry.coverage,
    });
  });
}
