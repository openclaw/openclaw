import { expect, it } from "vitest";
import { findSourceImportBackedges } from "../../../test/helpers/source-import-closure.js";

it("keeps transcript reconcile worker independent of writable agent database lifecycle", () => {
  expect(
    findSourceImportBackedges("src/config/sessions/session-transcript-reconcile.worker.ts", [
      "src/state/openclaw-agent-db.ts",
      "src/state/openclaw-agent-db-lifecycle.ts",
    ]),
  ).toEqual([]);
});
