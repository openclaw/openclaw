import { expect, it } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";

it("keeps the shared-state command worker independent of host runtime discovery", () => {
  expect(
    findSourceImportBackedges("src/state/openclaw-state-worker-runtime.ts", [
      "src/config/io.snapshot.ts",
      "src/config/validation-core.ts",
      "src/plugins/loader-runtime-load.ts",
      "src/channels/plugins/registry.ts",
      "packages/gateway-protocol/src/validator-registry.ts",
    ]),
  ).toEqual([]);
});
