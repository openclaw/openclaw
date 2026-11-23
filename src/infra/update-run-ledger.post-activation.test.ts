import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "./update-run-ledger.js";

const tempDirs = createTempDirTracker();
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

it("retains post-activation advice after success without reopening the update", () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-advice-") } };
  const run = createUpdateRun({ trigger: "control-ui" }, options);
  const finished = finishUpdateRun(run.runId, { status: "succeeded" }, options);
  const step = "post-activation doctor inspections";
  recordUpdateRunStep(run.runId, { step, status: "in_progress" }, options);
  expect(getUpdateRun(run.runId, options)?.steps).toContainEqual(
    expect.objectContaining({ step, status: "in_progress" }),
  );
  for (const name of [
    step,
    `warning:${step}`,
    `warning:${step}:2`,
    `diagnostic:${step}:2`,
    `finalize:doctor-lint:${step}`,
  ]) {
    recordUpdateRunStep(
      run.runId,
      { step: name, status: "completed", detail: "Inspection receipt." },
      options,
    );
  }
  recordUpdateRunStep(
    run.runId,
    { step: "late-non-advisory", status: "failed", reason: "must-not-change-outcome" },
    options,
  );
  const retained = getUpdateRun(run.runId, options)!;
  expect(retained).toMatchObject({
    status: "succeeded",
    phase: "finished",
    reason: null,
    finishedAtMs: finished.finishedAtMs,
  });
  expect(retained.steps).not.toContainEqual(expect.objectContaining({ step: "late-non-advisory" }));
  expect(retained.steps.filter(({ detail }) => detail === "Inspection receipt.")).toHaveLength(5);
});
