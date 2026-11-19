import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { projectUpdateRunFailure } from "../../ui/src/app/update-overlay-helpers.js";
import * as state from "../state/openclaw-state-db.js";
import * as ledger from "./update-run-ledger.js";
import { renderUpdateRunSummary } from "./update-run-notice.js";
import { toPublicUpdateRun } from "./update-run-record.js";
import { renderUpdateRunReport } from "./update-run-report.js";
import { SHIPPED_RESTART_FINISHER_STEP } from "./update-run-restart-finished.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await state.closeOpenClawStateDatabaseAsync();
  state.closeOpenClawStateDatabaseForTest();
});

const FINISHED =
  "The installed updater refused the Gateway restart; after it exited, the service definition was refreshed and OpenClaw 2026.11.6 is serving.";
const GAVE_UP =
  "Automatic Gateway restart after the installed updater exited stopped: the Gateway did not report ready on 2026.11.6 (observed no Gateway).";

/** A shipped updater's refused restart, then what the finisher records for each outcome. */
function refusedRestart(finished: boolean) {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-restart-finished-") } };
  const { runId } = ledger.createUpdateRun(
    { trigger: "cli", before: { version: "2026.11.5" }, target: { version: "2026.11.6" } },
    options,
  );
  ledger.recordUpdateRunStep(runId, { step: "restarting", status: "in_progress" }, options);
  ledger.finishUpdateRun(
    runId,
    { status: "failed", reason: "service-revalidation-failed", after: { version: "2026.11.6" } },
    options,
  );
  if (finished) {
    ledger.recordUpdateRunVerification(
      runId,
      {
        serviceRunning: true,
        runningVersion: "2026.11.6",
        versionMatch: true,
        readyz: true,
        settled: true,
      },
      options,
    );
  }
  ledger.recordUpdateRunDiagnostic(
    runId,
    finished ? FINISHED : GAVE_UP,
    options,
    SHIPPED_RESTART_FINISHER_STEP,
  );
  return toPublicUpdateRun(ledger.getUpdateRun(runId, options)!);
}

it("presents a refused restart that was finished and verified as a completed update", async () => {
  const run = refusedRestart(true);
  expect(run.status).toBe("failed");

  const report = renderUpdateRunReport(run);
  expect(report.headline).toBe(
    "✅ OpenClaw updated to 2026.11.6 (from 2026.11.5); 1 warning needs attention.",
  );
  expect(report.lines).toEqual(
    expect.arrayContaining([
      `Warning: ${FINISHED}`,
      "The recorded update outcome is unchanged (service-revalidation-failed); the target version was verified serving after the installed updater exited.",
    ]),
  );
  expect(report.markdown).not.toMatch(/failed:|Failed: |openclaw triage/u);
  expect(renderUpdateRunSummary(run)).toMatch(/^✅ OpenClaw updated\.\n/u);
  await expect(projectUpdateRunFailure(run)).resolves.toBeNull();
});

it("still reports a refused restart the finisher could not complete as failed", async () => {
  const run = refusedRestart(false);

  const report = renderUpdateRunReport(run);
  expect(report.headline).toBe("⚠️ OpenClaw update failed: service-revalidation-failed.");
  expect(report.lines).toContain(`Warning: ${GAVE_UP}`);
  expect(renderUpdateRunSummary(run)).toMatch(/^⚠️ OpenClaw couldn't finish updating\.\n/u);
  await expect(projectUpdateRunFailure(run)).resolves.toMatchObject({
    outcome: "failed",
    banner: { tone: "danger" },
  });
});
