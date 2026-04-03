import { describe } from "vitest";
import { getThreadingContractRegistry } from "./registry.js";
import { installChannelThreadingContractSuite } from "./suites.js";

for (const entry of getThreadingContractRegistry()) {
  describe(`${entry.id} threading contract`, () => {
    installChannelThreadingContractSuite({
      plugin: entry.plugin,
    });
  });
}
