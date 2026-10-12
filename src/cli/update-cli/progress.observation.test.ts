import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as snapshots from "../../infra/sqlite-snapshot-source.js";
import { createUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import * as reads from "../../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createUpdateProgress } from "./progress.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let presentation: ReturnType<typeof createUpdateProgress> | undefined;
afterEach(async () => {
  presentation?.dispose();
  presentation = undefined;
  await closeOpenClawStateDatabaseAsync();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("observes committed phases without a snapshot worker per tick, and does no disabled reads", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("update-progress-observation-") };
  const run = createUpdateRun({ trigger: "cli" }, { env });
  await closeOpenClawStateDatabaseAsync();
  const syncSnapshot = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
  const asyncSnapshot = vi.spyOn(snapshots, "startSqliteReadOnlyLocationAsync");
  const read = vi.spyOn(reads, "executeExistingOpenClawStateRead");
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.useFakeTimers();
  const settle = async () => {
    await Promise.all(read.mock.results.map((result) => result.value));
    await vi.advanceTimersByTimeAsync(0);
  };
  const context = { runId: run.runId, env };
  presentation = reads.withArtifactPreservingStateReads(() => createUpdateProgress(true, context));
  await settle();
  for (let tick = 0; tick < 5; tick++) {
    await vi.advanceTimersByTimeAsync(250);
    await settle();
  }
  expect(syncSnapshot.mock.calls.length + asyncSnapshot.mock.calls.length).toBeLessThanOrEqual(1);
  expect(log).toHaveBeenCalledWith("Phase: requested");

  recordUpdateRunPhase(run.runId, "verifying", {}, { env });
  await vi.advanceTimersByTimeAsync(250);
  await settle();
  expect(log).toHaveBeenCalledWith("Phase: verifying");
  presentation.dispose();
  syncSnapshot.mockClear();
  asyncSnapshot.mockClear();
  read.mockClear();
  presentation = createUpdateProgress(false, context);
  presentation.suspend();
  presentation.resume();
  await vi.advanceTimersByTimeAsync(1_250);
  presentation.dispose();
  expect(syncSnapshot).not.toHaveBeenCalled();
  expect(asyncSnapshot).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});
