import { describe } from "vitest";
import { getThreadingContractRegistry } from "../../../../test/helpers/channels/surface-contract-registry.js";
import { installChannelThreadingContractSuite } from "../../../../test/helpers/channels/threading-directory-contract-suites.js";

for (const entry of getThreadingContractRegistry()) {
  describe(`${entry.id} threading contract`, () => {
    installChannelThreadingContractSuite({
      plugin: entry.plugin,
    });
  });
}
