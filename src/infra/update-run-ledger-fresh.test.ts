import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunPhase } from "./update-run-ledger.js";
const tempDirs = createTempDirTracker();
function isolatedOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-ledger-fresh-") } };
}
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  tempDirs.cleanup();
});
it("refuses duplicate fresh recipe admission without changing its original ledger", () => {
  const options = isolatedOptions();
  const original = createUpdateRun(
    { trigger: "cli", runId: "550e8400-e29b-41d4-a716-446655440000", requireNewRun: true },
    options,
  );
  recordUpdateRunPhase(original.runId, "staging", {}, options);
  const before = getUpdateRun(original.runId, options);
  expect(() =>
    createUpdateRun({ trigger: "cli", runId: original.runId, requireNewRun: true }, options),
  ).toThrow("cannot adopt an existing update run");
  expect(getUpdateRun(original.runId, options)).toEqual(before);
  expect(createUpdateRun({ trigger: "cli", runId: original.runId }, options)).toEqual(before);
});
