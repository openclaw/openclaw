import { describe } from "vitest";
import { installChannelSurfaceContractSuite } from "../../../../test/helpers/channels/surface-contract-suite.js";
import { getSurfaceContractRegistry } from "./registry.js";

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
