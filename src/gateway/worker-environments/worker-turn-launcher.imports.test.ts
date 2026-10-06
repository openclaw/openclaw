import { expect, it } from "vitest";
import { findSourceImportBackedges } from "../../../test/helpers/source-import-closure.js";

it.each([
  "worker-turn-launcher.ts",
  "placement-dispatch-pending-results.ts",
  "placement-reclaim.ts",
  "repository-workspace-mutation.ts",
])("keeps %s independent of selected worker execution", (entry) => {
  expect(
    findSourceImportBackedges(`src/gateway/worker-environments/${entry}`, [
      "src/gateway/worker-environments/worker-turn-execution.ts",
      "src/gateway/worker-environments/workspace-result-finalize.ts",
      "src/gateway/worker-environments/placement-sandbox.ts",
    ]),
  ).toEqual([]);
});
