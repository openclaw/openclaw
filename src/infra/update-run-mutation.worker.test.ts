import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { getUpdateRunAsync } from "./update-run-reader.js";
import {
  createUpdateRunAsync,
  finishUpdateRunAsync,
  recordUpdateRunDiagnosticsAsync,
  recordUpdateRunPhaseAsync,
  recordUpdateRunStepAsync,
  recordUpdateRunVerificationAsync,
} from "./update-run-write.async.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it("records Gateway update history off-thread and publishes merged writes to warm readers", async () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("update-mutations-") } };
  const warn = vi.fn();
  const sql = observeMainThreadSql();
  sql.calibrate();
  let nativeCalls = 0;
  try {
    const run = await createUpdateRunAsync({ trigger: "api" }, options);
    expect(await getUpdateRunAsync(run.runId, options)).toMatchObject({ status: "running" });
    await Promise.all([
      recordUpdateRunPhaseAsync(
        run.runId,
        "validating",
        { target: { version: "2026.10.1" } },
        options,
      ),
      recordUpdateRunStepAsync(
        run.runId,
        { step: "notice:activating", status: "completed" },
        options,
      ),
      recordUpdateRunVerificationAsync(run.runId, { booted: true }, options),
      recordUpdateRunDiagnosticsAsync(
        run.runId,
        {
          rollbackOutcome: { status: "not-needed", reason: "fixture update" },
        },
        warn,
        options,
      ),
    ]);
    expect(await getUpdateRunAsync(run.runId, options)).toMatchObject({
      phase: "validating",
      target: { version: "2026.10.1" },
      verification: { booted: true, rollbackOutcome: { status: "not-needed" } },
      steps: expect.arrayContaining([{ step: "notice:activating", status: "completed" }]),
    });
    await finishUpdateRunAsync(
      run.runId,
      { status: "succeeded", after: { version: "2026.10.1" } },
      options,
    );
    await recordUpdateRunVerificationAsync(
      run.runId,
      { booted: false },
      { ...options, onlyIfRunning: true },
    );
    expect(await getUpdateRunAsync(run.runId, options)).toMatchObject({
      phase: "finished",
      status: "succeeded",
      after: { version: "2026.10.1" },
      verification: { booted: true },
    });
    await recordUpdateRunVerificationAsync(run.runId, { noticeDelivered: true }, options);
    await recordUpdateRunVerificationAsync(run.runId, { noticeDelivered: false }, options);
    expect((await getUpdateRunAsync(run.runId, options))?.verification.noticeDelivered).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    nativeCalls = sql.count();
  } finally {
    sql.restore();
  }
  expect(nativeCalls).toBe(0);
});
