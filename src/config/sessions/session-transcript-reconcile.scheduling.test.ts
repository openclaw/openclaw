import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  closeSessionTranscriptReconcileWorkerPool,
  getSessionTranscriptReconcileWorkerPoolSnapshot,
} from "./session-transcript-reconcile-pool.js";
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
  const options = { agentId: "main", env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
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
  });
  await persistSessionTranscriptTurn(
    { ...options, sessionId: "deferred", sessionKey: "agent:main:deferred" },
    {
      messages: [{ eventId: "message", message: { role: "user", content: "Deferred repair" } }],
      touchSessionEntry: false,
    },
  );
  await waitForSessionTranscriptIndexReconcile(options);
  await closeSessionTranscriptReconcileWorkerPool();
  const database = openOpenClawAgentDatabase(options);
  database.db.prepare("DELETE FROM session_transcript_fts").run();
  database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();

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
  expect(database.db.prepare("SELECT message_id, text FROM session_transcript_fts").all()).toEqual([
    { message_id: "message", text: "Deferred repair" },
  ]);
  expect(
    database.db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").all(),
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

it.for(["before", "after"] as const)(
  "retains a fresh deferred request when caller cancellation arrives %s it",
  async (cancellation, { onTestFinished }) => {
    const stateDir = useAutoCleanupTempDirTracker(onTestFinished).make(
      "openclaw-reconcile-handoff-",
    );
    const options = { agentId: "main", env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
    onTestFinished(async () => {
      await closeSessionTranscriptReconcileWorkerPool();
      await closeOpenClawAgentDatabasesAsync(stateDir);
      closeOpenClawStateDatabaseForTest();
    });
    await persistSessionTranscriptTurn(
      { ...options, sessionId: "handoff", sessionKey: "agent:main:handoff" },
      {
        messages: [
          { eventId: "message", message: { role: "user", content: "Fresh caller repair" } },
        ],
        touchSessionEntry: false,
      },
    );
    await waitForSessionTranscriptIndexReconcile(options);
    const database = openOpenClawAgentDatabase(options);
    database.db.exec(
      "DELETE FROM session_transcript_fts_rows; UPDATE session_transcript_index_state SET needs_rebuild = 1",
    );
    const controller = new AbortController();
    const settled: string[] = [];
    startSessionTranscriptIndexReconcile({
      ...options,
      signal: controller.signal,
      assertCurrent: () => controller.signal.throwIfAborted(),
    });
    const cancelled = waitForSessionTranscriptIndexReconcile(options).then(() =>
      settled.push("cancelled"),
    );
    if (cancellation === "before") {
      controller.abort(new Error("original caller cancelled"));
    }
    startSessionTranscriptIndexReconcile(options);
    const fresh = waitForSessionTranscriptIndexReconcile(options).then(() => settled.push("fresh"));
    if (cancellation === "after") {
      controller.abort(new Error("original caller cancelled"));
    }
    await Promise.all([cancelled, fresh]);
    expect(settled).toEqual(["cancelled", "fresh"]);
    expect(
      database.db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").all(),
    ).toEqual([{ needs_rebuild: 0 }]);
    expect(
      database.db.prepare("SELECT message_id, text FROM session_transcript_fts").all(),
    ).toEqual([{ message_id: "message", text: "Fresh caller repair" }]);
  },
);
