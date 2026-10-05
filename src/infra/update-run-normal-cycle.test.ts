import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "./update-run-ledger.js";
import { recordLatestUpdateRunNormalCycleAsync } from "./update-run-normal-cycle.js";
import {
  getLatestUpdateRunAwaitingNormalCycle,
  recordLatestUpdateRunNormalCycle,
} from "./update-run-normal-cycle.test-support.js";
import { recordUpdateRunNormalCycleAsync } from "./update-run-write.async.js";

const tempDirs = createTempDirTracker();

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("worker-backed normal-cycle promotion", () => {
  it("records a normal-cycle promotion without changing the existing confirmation contract", () => {
    const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-normal-cycle-sync-") } };
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const run = createUpdateRun({ trigger: "cli" }, options);
    recordUpdateRunVerification(
      run.runId,
      {
        serviceRunning: true,
        versionMatch: true,
        settled: true,
        readyz: true,
        channelsReady: true,
        pluginErrors: [],
      },
      options,
    );
    finishUpdateRun(run.runId, { status: "succeeded" }, options);
    expect(recordLatestUpdateRunNormalCycle({ ...options, nowMs: 11_000 })).toMatchObject({
      runId: run.runId,
      verification: { normalCycle: { status: "pass", observedAtMs: 11_000 } },
    });
    expect(recordLatestUpdateRunNormalCycle({ ...options, nowMs: 12_000 })).toBeUndefined();
    clock.mockRestore();
  });

  it("persists the scheduled-cycle receipt through the state worker", async () => {
    const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-normal-cycle-") } };
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const run = createUpdateRun({ trigger: "cli" }, options);
    recordUpdateRunVerification(
      run.runId,
      {
        serviceRunning: true,
        versionMatch: true,
        settled: true,
        readyz: true,
        channelsReady: true,
        pluginErrors: [],
      },
      options,
    );
    finishUpdateRun(run.runId, { status: "succeeded" }, options);

    const promoted = await recordLatestUpdateRunNormalCycleAsync({ ...options, nowMs: 11_000 });

    expect(promoted).toMatchObject({
      runId: run.runId,
      verification: { normalCycle: { status: "pass", observedAtMs: 11_000 } },
    });
    expect(getUpdateRun(run.runId, options)?.verification.normalCycle).toEqual({
      status: "pass",
      observedAtMs: 11_000,
    });
    clock.mockRestore();
  });

  it("rechecks latest-run and active-update eligibility in the persistence transaction", async () => {
    const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-normal-cycle-race-") } };
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const run = createUpdateRun({ trigger: "cli" }, options);
    recordUpdateRunVerification(
      run.runId,
      {
        serviceRunning: true,
        versionMatch: true,
        settled: true,
        readyz: true,
        channelsReady: true,
        pluginErrors: [],
      },
      options,
    );
    finishUpdateRun(run.runId, { status: "succeeded" }, options);

    const selectedBeforeTheWrite = getLatestUpdateRunAwaitingNormalCycle({
      ...options,
      nowMs: 11_000,
    });
    expect(selectedBeforeTheWrite?.runId).toBe(run.runId);
    createUpdateRun({ trigger: "cli" }, options);

    const persisted = await recordUpdateRunNormalCycleAsync(
      selectedBeforeTheWrite!.runId,
      { normalCycle: { status: "pass", observedAtMs: 11_000 } },
      { nowMs: 11_000, maxAgeMs: 24 * 60 * 60 * 1000 },
      options,
    );

    expect(persisted).toBeUndefined();
    expect(getUpdateRun(run.runId, options)?.verification.normalCycle).toBeUndefined();
    clock.mockRestore();
  });
});
