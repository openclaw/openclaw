import { expect, it } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";

it("keeps Gateway startup out of ordinary config preflight", () => {
  expect(
    findSourceImportBackedges("src/commands/startup-config-preflight.ts", [
      "src/cli/gateway-cli/pre-bootstrap.ts",
      "src/state/state-upgrade-startup.ts",
    ]),
  ).toEqual([]);
});
