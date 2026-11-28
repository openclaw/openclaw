import { afterEach, expect, it, vi } from "vitest";
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
  vi.unstubAllEnvs();
});

it.each(["completed", "failed"] as const)(
  "retains final postcompletion plugin %s without changing the core outcome",
  (status) => {
    const stateDir = tempDirs.make("openclaw-update-plugin-receipt-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const run = createUpdateRun({ trigger: "control-ui" }, options);
    const finished = finishUpdateRun(run.runId, { status: "succeeded" }, options);
    recordUpdateRunStep(
      run.runId,
      { step: "plugins", status: "in_progress", detail: "Updating plugins…" },
      options,
    );
    expect(getUpdateRun(run.runId, options)?.steps).not.toContainEqual(
      expect.objectContaining({ step: "plugins" }),
    );
    const detail = "Plugin maintenance receipt.";
    recordUpdateRunStep(
      run.runId,
      {
        step: "plugins",
        status,
        startedAtMs: 100,
        endedAtMs: 200,
        detail,
      },
      options,
    );
    const retained = getUpdateRun(run.runId, options)!;
    expect(retained).toMatchObject({
      status: "succeeded",
      phase: "finished",
      reason: null,
      finishedAtMs: finished.finishedAtMs,
    });
    expect(retained.steps).toContainEqual(
      expect.objectContaining({
        step: "plugins",
        status,
        startedAtMs: 100,
        endedAtMs: 200,
        detail,
      }),
    );
  },
);
