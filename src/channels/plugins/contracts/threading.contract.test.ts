import { describe } from "vitest";
import { threadingContractRegistry } from "./registry.js";
import { installChannelThreadingContractSuite } from "./suites.js";

for (const entry of threadingContractRegistry) {
  describe(`${entry.id} threading contract`, () => {
    installChannelThreadingContractSuite({
      plugin: entry.plugin,
    });
  });
}
