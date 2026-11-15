import { expect, it } from "vitest";
import { findSourceImportBackedges } from "../../../test/helpers/source-import-closure.js";

it("keeps database registration independent of schema and ownership operation runtimes", () => {
  expect(
    findSourceImportBackedges("src/cli/program/register.database.ts", [
      "src/state/openclaw-agent-schema-inspection.ts",
      "src/state/openclaw-database-preflight.ts",
      "src/state/openclaw-state-db-maintenance.ts",
      "src/state/openclaw-state-ownership-operations.ts",
      "src/state/openclaw-state-ownership.ts",
    ]),
  ).toEqual([]);
});
