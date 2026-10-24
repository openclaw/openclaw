import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as snapshots from "../../infra/sqlite-snapshot-source.js";
import { createUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import * as reads from "../../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createUpdateProgress } from "./progress.js";
import { createUnregisteredStateOwner } from "./unregistered-state-owner.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let presentation: ReturnType<typeof createUpdateProgress> | undefined;
afterEach(async () => {
  presentation?.dispose();
  presentation = undefined;
  await closeOpenClawStateDatabaseAsync();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function observation() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("update-progress-observation-") };
  const filename = resolveOpenClawStateSqlitePath(env);
  const run = createUpdateRun({ trigger: "cli" }, { env });
  await closeOpenClawStateDatabaseAsync();
  const read = vi.spyOn(reads, "executeExistingOpenClawStateRead");
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  const settle = async (ms = 0, contention = false) => {
    if (ms) {
      await vi.advanceTimersByTimeAsync(ms);
    }
    const pending = read.mock.results.map((result) => result.value);
    await (contention ? Promise.allSettled(pending) : Promise.all(pending));
    await vi.advanceTimersByTimeAsync(0);
  };
  return { context: { runId: run.runId, env }, filename, read, log, settle };
}

it("observes committed phases without a snapshot worker per tick, and does no disabled reads", async () => {
  const { context, read, log, settle } = await observation();
  const syncSnapshot = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
  const asyncSnapshot = vi.spyOn(snapshots, "startSqliteReadOnlyLocationAsync");
  vi.useFakeTimers();
  presentation = reads.withArtifactPreservingStateReads(() => createUpdateProgress(true, context));
  await settle();
  for (let tick = 0; tick < 5; tick++) {
    await settle(250);
  }
  expect(syncSnapshot.mock.calls.length + asyncSnapshot.mock.calls.length).toBeLessThanOrEqual(1);
  expect(log).toHaveBeenCalledWith("Phase: requested");

  recordUpdateRunPhase(context.runId, "verifying", {}, { env: context.env });
  await settle(250);
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

it("resumes progress quietly after foreign offline maintenance releases custody", async () => {
  const { context, filename, read, log, settle } = await observation();
  using owner = createUnregisteredStateOwner(filename, "sqlite-maintenance", process.ppid);
  const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.useFakeTimers();
  presentation = createUpdateProgress(true, context);
  await settle(0, true);
  await settle(250, true);
  expect(read).toHaveBeenCalledTimes(2);
  expect(error).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  owner.release();
  recordUpdateRunPhase(context.runId, "verifying", {}, { env: context.env });
  await settle(250, true);
  expect(log).toHaveBeenCalledWith("Phase: verifying");
  expect(error).not.toHaveBeenCalled();
});
