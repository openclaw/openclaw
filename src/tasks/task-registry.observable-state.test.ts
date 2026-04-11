import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { startTaskRunByRunId } from "./task-executor.js";
import { createTaskRecord, deleteTaskRecordById, resetTaskRegistryForTests } from "./task-registry.js";
import { resolveObservableWorkerStatePath } from "./task-registry.observable-state.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

describe("task-registry observable worker state", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryForTests({ persist: false });
  });

  it("writes worker-state.json on task create and update", async () => {
    await withStateDirEnv("openclaw-observable-worker-state-", async ({ stateDir }) => {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      resetTaskRegistryForTests({ persist: false });

      createTaskRecord({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:subagent:child",
        runId: "run-observable-1",
        task: "Inspect task lifecycle",
        status: "queued",
        deliveryStatus: "pending",
      });

      const workerStatePath = resolveObservableWorkerStatePath();
      expect(existsSync(workerStatePath)).toBe(true);

      let snapshot = JSON.parse(readFileSync(workerStatePath, "utf8")) as {
        summary: { total: number; byStatus: { queued: number } };
        workers: Array<{ runId?: string; status: string; childSessionKey?: string }>;
      };
      expect(snapshot.summary.total).toBe(1);
      expect(snapshot.summary.byStatus.queued).toBe(1);
      expect(snapshot.workers[0]).toMatchObject({
        runId: "run-observable-1",
        status: "queued",
        childSessionKey: "agent:main:subagent:child",
      });

      startTaskRunByRunId({
        runId: "run-observable-1",
        startedAt: 100,
        lastEventAt: 100,
        eventSummary: "Started.",
      });

      snapshot = JSON.parse(readFileSync(workerStatePath, "utf8"));
      expect(snapshot.summary.byStatus.queued).toBe(0);
      expect(snapshot.workers[0]).toMatchObject({
        runId: "run-observable-1",
        status: "running",
      });
    });
  });

  it("updates worker-state.json when a task is deleted", async () => {
    await withStateDirEnv("openclaw-observable-worker-state-delete-", async ({ stateDir }) => {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      resetTaskRegistryForTests({ persist: false });

      const created = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:acp:child",
        runId: "run-observable-delete",
        task: "Delete me",
        status: "running",
        deliveryStatus: "pending",
      });

      expect(deleteTaskRecordById(created.taskId)).toBe(true);

      const snapshot = JSON.parse(readFileSync(resolveObservableWorkerStatePath(), "utf8")) as {
        summary: { total: number };
        workers: unknown[];
      };
      expect(snapshot.summary.total).toBe(0);
      expect(snapshot.workers).toEqual([]);
    });
  });
});
