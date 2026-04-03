import { describe } from "vitest";
import { installChannelThreadingContractSuite } from "../../../../test/helpers/channels/threading-directory-contract-suites.js";
import { getThreadingContractRegistry } from "./registry.js";

for (const entry of getThreadingContractRegistry()) {
  describe(`${entry.id} threading contract`, () => {
    installChannelThreadingContractSuite({
      plugin: entry.plugin,
    });
  });
}
