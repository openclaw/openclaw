import { describe } from "vitest";
import { surfaceContractRegistry } from "./registry.js";
import { installChannelSurfaceContractSuite } from "./suites.js";

for (const entry of surfaceContractRegistry) {
  for (const surface of entry.surfaces) {
    describe(`${entry.id} ${surface} surface contract`, () => {
      installChannelSurfaceContractSuite({
        plugin: entry.plugin,
        surface,
      });
    });
  }
}
