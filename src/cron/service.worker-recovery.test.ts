import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readCronRunRecordsForTests } from "./run-history.test-support.js";
import { CronService } from "./service.js";

it.for(["recover", "pause", "stop", "retire"] as const)(
  "handles idle native worker loss with lifecycle control %s",
  { timeout: 10_000 },
  async (control, { signal }) => {
    const fixture = await createOpenClawTestState({ label: "cron-native-loss", applyEnv: true });
    const scheduler = new GatewayScheduler();
    const completed = new Map<string, ReturnType<typeof createDeferredCore<void>>>();
    const executed: string[] = [];
    const cron = new CronService({
      scheduler,
      env: fixture.env,
      storePath: fixture.statePath("cron", "jobs.json"),
      cronEnabled: true,
      defaultAgentId: "main",
      log: { debug() {}, info() {}, warn() {}, error() {} },
      enqueueSystemEvent() {},
      runSessionEvent: async ({ text }) => {
        executed.push(text);
        return { status: "ok" };
      },
      runIsolatedAgentJob: async () => {
        throw new Error("Unexpected agent execution");
      },
      onEvent: (event) => {
        if (event.action === "finished" && event.status === "ok") {
          completed.get(event.jobId)?.resolve();
        }
      },
    });
    const add = async (name: string) => {
      const job = await cron.add({
        name,
        agentId: "main",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(Date.now() + 250).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: name },
      });
      const finished = createDeferredCore();
      completed.set(job.id, finished);
      return { job, finished: finished.promise };
    };
    try {
      await cron.start();

      const first = await add("before-loss");
      await withinTest(first.finished, signal);

      const receipts = readCronRunRecordsForTests(first.job.id);
      expect(receipts).toHaveLength(1);
      const next = await add("after-loss");
      const messages = vi.spyOn(Worker.prototype, "postMessage");
      let worker: Worker;
      try {
        await executeOpenClawStateWorker(captureOpenClawStateWorkerContext(), {
          type: "nativeHookRelay.read",
          input: { relayId: "cron-native-loss" },
        });
        const captured = messages.mock.contexts[0];
        if (!(captured instanceof Worker)) {
          throw new Error("Expected the real shared-state worker");
        }
        worker = captured;
      } finally {
        messages.mockRestore();
      }
      if (control === "pause") {
        cron.pauseScheduling();
      }
      if (control === "stop") {
        cron.stop();
      }
      const subsequent = vi.spyOn(Worker.prototype, "postMessage");
      try {
        if (control === "retire") {
          await closeOpenClawStateDatabaseAsync();
        } else {
          await worker.terminate();
        }
        expect(worker.threadId).toBe(-1);
        await cron.waitForIdle();
        if (control !== "recover") {
          expect(subsequent.mock.contexts.every((sender) => sender === worker)).toBe(true);
          expect(executed).toEqual(["before-loss"]);
        }
      } finally {
        subsequent.mockRestore();
      }
      if (control === "stop" || control === "retire") {
        return;
      }
      if (control === "pause") {
        cron.resumeScheduling();
      }
      await withinTest(next.finished, signal);
      expect(executed).toEqual(["before-loss", "after-loss"]);
      expect(readCronRunRecordsForTests(first.job.id)).toEqual(receipts);
      expect(readCronRunRecordsForTests(next.job.id)).toHaveLength(1);
    } finally {
      cron.stop();
      await cron.waitForIdle();
      await scheduler.stop();
      await fixture.cleanup();
    }
  },
);
