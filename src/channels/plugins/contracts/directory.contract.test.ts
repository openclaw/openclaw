import { describe } from "vitest";
import { directoryContractRegistry } from "./registry.js";
import { installChannelDirectoryContractSuite } from "./suites.js";

for (const entry of directoryContractRegistry) {
  describe(`${entry.id} directory contract`, () => {
    installChannelDirectoryContractSuite({
      plugin: entry.plugin,
      invokeLookups: entry.invokeLookups,
    });
  });
}
