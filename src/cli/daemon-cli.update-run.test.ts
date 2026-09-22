import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createUpdateRun, getUpdateRun } from "../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { finishUpdateRun, recordUpdateRunDiagnostic } from "./daemon-cli.js";

const tempDirs = createTempDirTracker();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

it("exports the terminal-safe update diagnostic writer for installed-runtime finalization", () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-daemon-ledger-") } };
  const run = createUpdateRun({ trigger: "cli" }, options);
  finishUpdateRun(run.runId, { status: "failed", reason: "post-update-failed" }, options);

  recordUpdateRunDiagnostic(
    run.runId,
    "Gateway availability is unverified after failed settlement.",
    options,
    "warning:gateway-availability",
  );

  const saved = getUpdateRun(run.runId, options);
  expect(saved).toMatchObject({
    status: "failed",
    reason: "post-update-failed",
  });
  expect(saved?.steps).toContainEqual(
    expect.objectContaining({
      step: "warning:gateway-availability",
      status: "completed",
    }),
  );
});
