import { describe } from "vitest";
import { getSurfaceContractRegistry } from "./registry.js";
import { installChannelSurfaceContractSuite } from "./suites.js";

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
