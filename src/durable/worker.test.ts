import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDurableWorkflowRegistry } from "./registry.js";
import { openDurableWorkflowSqliteStore } from "./sqlite-store.js";
import {
  runDurableWorkerBatch,
  startDurableWorkflowWorker,
  startDurableWorkflowWorkerFromEnv,
} from "./worker.js";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-worker-"));
  const store = openDurableWorkflowSqliteStore({
    path: path.join(dir, "openclaw.sqlite"),
  });
  return {
    store,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  expect(condition()).toBe(true);
}

describe("durable workflow worker", () => {
  it("runs a bounded batch of runnable steps", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createDurableWorkflowRegistry();
      registry.registerStepHandler("tool", () => ({
        kind: "succeeded",
        output: { ok: true },
        completeRun: false,
      }));
      const run = store.createRun({
        workflowId: "test.workflow",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const stepOne = store.createStep({
        workflowRunId: run.workflowRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 110,
      });
      const stepTwo = store.createStep({
        workflowRunId: run.workflowRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 120,
      });

      const result = await runDurableWorkerBatch({
        store,
        registry,
        workerId: "worker-1",
        workflowId: "test.workflow",
        maxSteps: 2,
        now: () => 200,
      });

      expect(result.claimedSteps).toBe(2);
      expect(result.idle).toBe(false);
      expect(store.listSteps(run.workflowRunId)).toMatchObject([
        {
          stepId: stepOne.stepId,
          status: "succeeded",
          recoveryState: "terminal",
        },
        {
          stepId: stepTwo.stepId,
          status: "succeeded",
          recoveryState: "terminal",
        },
      ]);
    } finally {
      cleanup();
    }
  });

  it("starts, claims work, and stops cleanly", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createDurableWorkflowRegistry();
      registry.registerStepHandler("tool", () => ({
        kind: "succeeded",
        output: { ok: true },
        completeRun: true,
      }));
      const run = store.createRun({
        workflowId: "test.workflow",
        status: "queued",
        recoveryState: "runnable",
      });
      store.createStep({
        workflowRunId: run.workflowRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
      });

      const worker = startDurableWorkflowWorker({
        store,
        registry,
        workerId: "worker-loop",
        pollIntervalMs: 5,
        maxConcurrency: 1,
        workflowId: "test.workflow",
      });

      await waitFor(() => worker.getStatus().claimedSteps === 1);
      await worker.stop();

      expect(worker.getStatus()).toMatchObject({
        running: false,
        stopped: true,
        inFlight: 0,
        claimedSteps: 1,
      });
      expect(store.getRun(run.workflowRunId)).toMatchObject({
        status: "succeeded",
        recoveryState: "terminal",
      });
    } finally {
      cleanup();
    }
  });

  it("does not start from env unless the worker flag is explicit", async () => {
    const registry = createDurableWorkflowRegistry();
    const worker = startDurableWorkflowWorkerFromEnv({
      registry,
      workerId: "disabled-worker",
      env: {
        OPENCLAW_DURABLE_WORKFLOWS: "1",
      },
    });

    expect(worker.getStatus()).toMatchObject({
      running: false,
      stopped: true,
      claimedSteps: 0,
    });
    await worker.stop();
  });

  it("starts from env only when workflows and worker flags are both explicit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-worker-env-"));
    try {
      const registry = createDurableWorkflowRegistry();
      registry.registerStepHandler("tool", () => ({ kind: "succeeded" }));
      const worker = startDurableWorkflowWorkerFromEnv({
        registry,
        workerId: "enabled-worker",
        env: {
          OPENCLAW_STATE_DIR: dir,
          OPENCLAW_DURABLE_WORKFLOWS: "1",
          OPENCLAW_DURABLE_WORKER: "1",
          OPENCLAW_DURABLE_WORKER_POLL_INTERVAL_MS: "5",
          OPENCLAW_DURABLE_WORKER_CLAIM_TTL_MS: "50",
          OPENCLAW_DURABLE_WORKER_MAX_CONCURRENCY: "2",
        },
      });

      expect(worker.getStatus()).toMatchObject({
        workerId: "enabled-worker",
        running: true,
        stopped: false,
        pollIntervalMs: 5,
        maxConcurrency: 2,
        claimTtlMs: 50,
      });
      await worker.stop();
      expect(worker.getStatus()).toMatchObject({
        running: false,
        stopped: true,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed from env when no step handlers are registered", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-worker-env-empty-"));
    try {
      const store = openDurableWorkflowSqliteStore({ path: path.join(dir, "openclaw.sqlite") });
      const run = store.createRun({
        workflowId: "test.workflow",
        status: "queued",
        recoveryState: "runnable",
      });
      store.createStep({
        workflowRunId: run.workflowRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
      });
      store.close();

      const worker = startDurableWorkflowWorkerFromEnv({
        registry: createDurableWorkflowRegistry(),
        workerId: "empty-registry-worker",
        env: {
          OPENCLAW_STATE_DIR: dir,
          OPENCLAW_DURABLE_WORKFLOWS: "1",
          OPENCLAW_DURABLE_WORKER: "1",
          OPENCLAW_DURABLE_WORKER_POLL_INTERVAL_MS: "5",
        },
      });

      expect(worker.getStatus()).toMatchObject({
        running: false,
        stopped: true,
        claimedSteps: 0,
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      await worker.stop();

      const verifyStore = openDurableWorkflowSqliteStore({
        path: path.join(dir, "openclaw.sqlite"),
      });
      try {
        expect(verifyStore.getRun(run.workflowRunId)).toMatchObject({
          status: "queued",
          recoveryState: "runnable",
        });
        expect(verifyStore.listSteps(run.workflowRunId)[0]).toMatchObject({
          status: "queued",
          recoveryState: "runnable",
        });
        expect(verifyStore.listSteps(run.workflowRunId)[0]?.claimedBy).toBeUndefined();
      } finally {
        verifyStore.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
