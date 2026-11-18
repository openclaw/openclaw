import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  closeSessionTranscriptReconcileWorkerPool,
  getSessionTranscriptReconcileWorkerPoolSnapshot,
} from "./session-transcript-reconcile-pool.js";
import * as fixtures from "./session-transcript-reconcile.fixtures.test-support.js";
import {
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";

it("drains deferred reconciliation after the caller retires its timer queue", async ({
  onTestFinished,
  signal,
}) => {
  const stateDir = useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-reconcile-clock-");
  const { options, scope } = fixtures.reconcileScope(stateDir, "deferred");
  let releaseYield: (() => void) | undefined;
  const release = () => {
    releaseYield?.();
    releaseYield = undefined;
  };
  onTestFinished(async () => {
    signal.removeEventListener("abort", release);
    release();
    await closeSessionTranscriptReconcileWorkerPool();
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
  });
  setRuntimeConfigSnapshot({});
  await fixtures.seedTranscript(scope, "message", "Deferred repair");
  await waitForSessionTranscriptIndexReconcile(options);
  await closeSessionTranscriptReconcileWorkerPool();
  const database = openOpenClawAgentDatabase(options);
  database.db.prepare("DELETE FROM session_transcript_fts").run();
  fixtures.markRebuild(database.db);

  signal.throwIfAborted();
  // A failing regression must release the withheld callback before fixture teardown.
  signal.addEventListener("abort", release, { once: true });
  const realSetImmediate = globalThis.setImmediate;
  const immediate = vi.spyOn(globalThis, "setImmediate").mockImplementationOnce((callback) => {
    releaseYield = () => callback();
    return realSetImmediate(() => undefined);
  });
  try {
    startSessionTranscriptIndexReconcile(options);
  } finally {
    immediate.mockRestore();
  }

  await closeSessionTranscriptReconcileWorkerPool();
  expect(fixtures.projectionMessages(database.db)).toEqual([
    { message_id: "message", text: "Deferred repair" },
  ]);
  expect(
    fixtures.rows(database.db, "SELECT needs_rebuild FROM session_transcript_index_state"),
  ).toEqual([{ needs_rebuild: 0 }]);
  expect(getSessionTranscriptReconcileWorkerPoolSnapshot()).toMatchObject({
    maxWorkers: 1,
    workers: 0,
    activeTasks: 0,
    pendingTasks: 0,
  });
}, 30_000);

it("keeps a missing projection store absent", async ({ onTestFinished }) => {
  const stateDir = useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-reconcile-missing-");
  const options = {
    agentId: "main",
    path: path.join(stateDir, "missing.sqlite"),
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  };
  onTestFinished(async () => {
    await closeSessionTranscriptReconcileWorkerPool();
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawStateDatabaseForTest();
  });
  await expect(reconcileSessionTranscriptIndexes(options)).resolves.toEqual({
    reconciledSessions: 0,
  });
  expect(fs.existsSync(options.path)).toBe(false);
});
