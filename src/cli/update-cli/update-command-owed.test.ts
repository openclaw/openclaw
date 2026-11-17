import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as ledger from "../../infra/update-run-ledger.js";
import * as state from "../../state/openclaw-state-db.js";
import { recordOwedUpdateStep } from "./update-command-owed.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.useRealTimers();
  await state.closeOpenClawStateDatabaseAsync();
  state.closeOpenClawStateDatabaseForTest();
});

it("leaves a step owed by the earlier update when the update that took it over fails", () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-owed-") } };
  // Runs are ordered by creation time.
  vi.useFakeTimers({ toFake: ["Date"], now: 1_800_000_000_000 });
  const earlier = ledger.createUpdateRun({ trigger: "cli" }, options).runId;
  ledger.finishUpdateRun(earlier, { status: "succeeded" }, options);
  ledger.recordUpdateRunOwedStep(earlier, "service-definition", "install failed", options);
  vi.advanceTimersByTime(1_000);
  const later = ledger.createUpdateRun({ trigger: "cli" }, options).runId;
  const again = { id: "service-definition" as const, reason: "install failed again" };

  expect(recordOwedUpdateStep({ runId: later, ...options }, again)).toBe(true);
  expect(ledger.readOwedUpdateSteps(options)).toEqual([{ ...again, runId: later }]);

  ledger.finishUpdateRun(later, { status: "failed" }, options);

  expect(ledger.readOwedUpdateSteps(options)).toEqual([
    { id: "service-definition", runId: earlier, reason: "install failed" },
  ]);
});
