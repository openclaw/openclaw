import { afterEach, describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { defaultTaskOperationsRuntime } from "./operations-runtime.js";
import { findTaskByRunId, resetTaskRegistryForTests } from "./task-registry.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

async function withTaskStateDir(run: () => Promise<void>): Promise<void> {
  await withTempDir({ prefix: "openclaw-task-operations-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskRegistryForTests();
    try {
      await run();
    } finally {
      resetTaskRegistryForTests();
    }
  });
}

describe("task operations runtime", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryForTests();
  });

  it("creates and transitions task records through the generic operations runtime", async () => {
    await withTaskStateDir(async () => {
      const created = await defaultTaskOperationsRuntime.dispatch({
        type: "create",
        namespace: "tasks",
        kind: "cli",
        status: "queued",
        requesterSessionKey: "agent:test:main",
        childSessionKey: "agent:test:child",
        runId: "run-ops-create",
        title: "Task title",
        description: "Do the thing",
      });

      expect(created.matched).toBe(true);
      expect(created.created).toBe(true);
      expect(created.record).toMatchObject({
        namespace: "tasks",
        kind: "cli",
        status: "queued",
        title: "Task title",
        description: "Do the thing",
        runId: "run-ops-create",
      });

      const progressed = await defaultTaskOperationsRuntime.dispatch({
        type: "transition",
        runId: "run-ops-create",
        status: "running",
        at: 100,
        startedAt: 100,
        progressSummary: "Started work",
      });

      expect(progressed.record).toMatchObject({
        status: "running",
        progressSummary: "Started work",
      });

      const completed = await defaultTaskOperationsRuntime.dispatch({
        type: "transition",
        runId: "run-ops-create",
        status: "succeeded",
        at: 200,
        endedAt: 200,
        terminalSummary: "All done",
      });

      expect(completed.record).toMatchObject({
        status: "succeeded",
        terminalSummary: "All done",
      });
      expect(findTaskByRunId("run-ops-create")).toMatchObject({
        status: "succeeded",
        terminalSummary: "All done",
      });
    });
  });

  it("lists and summarizes task-backed operations", async () => {
    await withTaskStateDir(async () => {
      await defaultTaskOperationsRuntime.dispatch({
        type: "create",
        namespace: "tasks",
        kind: "acp",
        status: "running",
        requesterSessionKey: "agent:test:main",
        runId: "run-ops-list-1",
        description: "One",
        startedAt: 10,
      });
      await defaultTaskOperationsRuntime.dispatch({
        type: "create",
        namespace: "tasks",
        kind: "cron",
        status: "failed",
        requesterSessionKey: "agent:test:main",
        runId: "run-ops-list-2",
        description: "Two",
        endedAt: 20,
        terminalSummary: "Failed",
      });

      const listed = await defaultTaskOperationsRuntime.list({
        namespace: "tasks",
      });
      const summary = await defaultTaskOperationsRuntime.summarize({
        namespace: "tasks",
      });

      expect(listed).toHaveLength(2);
      expect(summary).toEqual({
        total: 2,
        active: 1,
        terminal: 1,
        failures: 1,
        byNamespace: { tasks: 2 },
        byKind: { acp: 1, cron: 1 },
        byStatus: { failed: 1, running: 1 },
      });
    });
  });

  it("patches notify policy and exposes audit plus maintenance", async () => {
    await withTaskStateDir(async () => {
      const created = await defaultTaskOperationsRuntime.dispatch({
        type: "create",
        namespace: "tasks",
        kind: "cli",
        status: "running",
        requesterSessionKey: "agent:test:main",
        runId: "run-ops-patch",
        description: "Patch me",
        startedAt: Date.now() - 31 * 60_000,
      });

      expect(created.record?.metadata?.notifyPolicy).toBe("done_only");

      const findings = await defaultTaskOperationsRuntime.audit({
        namespace: "tasks",
        severity: "error",
        code: "stale_running",
      });

      const patched = await defaultTaskOperationsRuntime.dispatch({
        type: "patch",
        operationId: created.record?.operationId,
        metadataPatch: {
          notifyPolicy: "silent",
        },
      });

      expect(patched.record?.metadata?.notifyPolicy).toBe("silent");

      const preview = await defaultTaskOperationsRuntime.maintenance({
        namespace: "tasks",
      });

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        severity: "error",
        code: "stale_running",
        operation: {
          operationId: created.record?.operationId,
        },
      });
      expect(preview).toEqual({
        reconciled: 0,
        cleanupStamped: 0,
        pruned: 0,
      });
    });
  });
});
