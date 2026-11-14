import { expect, it } from "vitest";
import { findSourceImportBackedges } from "../../../test/helpers/source-import-closure.js";

it("keeps state engine and schema preparation out of ordinary cron reader imports", () => {
  expect(
    findSourceImportBackedges("src/cron/store/read-only.worker.ts", [
      "src/state/openclaw-state-db-engine.ts",
      "src/state/openclaw-state-db-read-connection.ts",
      "src/state/openclaw-state-feature-schema.ts",
      "src/cron/store/save.kernel.ts",
    ]),
  ).toEqual([]);
});
