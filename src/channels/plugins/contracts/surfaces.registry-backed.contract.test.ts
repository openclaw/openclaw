import { describe } from "vitest";
import {
  getDirectoryContractRegistry,
  getSurfaceContractRegistry,
  getThreadingContractRegistry,
} from "./registry.js";
import {
  installChannelDirectoryContractSuite,
  installChannelSurfaceContractSuite,
  installChannelThreadingContractSuite,
} from "./suites.js";

for (const entry of getSurfaceContractRegistry()) {
  for (const surface of entry.surfaces) {
    describe(`${entry.id} ${surface} surface contract`, () => {
      installChannelSurfaceContractSuite({
        plugin: entry.plugin,
        surface,
      });
    });
  }
}

for (const entry of getThreadingContractRegistry()) {
  describe(`${entry.id} threading contract`, () => {
    installChannelThreadingContractSuite({
      plugin: entry.plugin,
    });
  });
}

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
