import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { setupCronRegressionFixtures } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createCronServiceWithStateForTest, createNoopLogger } from "../service.test-harness.js";
import * as runQueue from "./run-queue.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-recovery-settlement-" });

it.for(["replacement-loss", "stop-during-launch"] as const)(
  "keeps accepted replacement work under custody: %s",
  { timeout: 10_000 },
  async (outcome, { signal }) => {
    vi.useRealTimers();
    const { storePath } = fixtures.makeStorePath();
    const scheduler = createTestGatewayScheduler("fake-timers");
    const executing = createDeferred();
    const finishRun = createDeferred();
    const finishStartup = createDeferred();
    let startupReturned = false;
    let completed = false;
    const reconnected = createDeferred();
    let stoppedDrain: Promise<void> | undefined;
    let stoppedDrainSettled = false;
    const log = createNoopLogger();
    log.info.mockImplementation((_fields, message) => {
      if (message === "cron: scheduler reconnected after native worker loss") {
        reconnected.resolve();
      }
    });
    const runSessionEvent = vi.fn(async () => {
      if (outcome === "stop-during-launch") {
        // The real launch is registered, but its startup caller is still held below.
        expect(startupReturned).toBe(false);
        cron.stop();
        stoppedDrain = state.schedulerDrain;
        void stoppedDrain.then(() => {
          stoppedDrainSettled = true;
        });
      }
      executing.resolve();
      finishStartup.resolve();
      await finishRun.promise;
      completed = true;
      return { status: "ok" as const };
    });
    const { cron, state } = createCronServiceWithStateForTest({
      scheduler,
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      log,
      enqueueSystemEvent: vi.fn(),
      runSessionEvent,
      runIsolatedAgentJob: vi.fn(),
    });
    const launchResult = runQueue.launchCronRunQueueResult;
    const launchBoundary =
      outcome === "stop-during-launch"
        ? vi.spyOn(runQueue, "launchCronRunQueueResult").mockImplementation(async (...args) => {
            await launchResult(...args);
            if (args[1].launches.length > 0) {
              // Hold only the return boundary, never native dispatch or run execution.
              await finishStartup.promise;
              startupReturned = true;
            }
          })
        : undefined;
    const workers: Worker[] = [];
    // Observe real scheduler dispatch; keep native execution and admission intact.
    // oxlint-disable-next-line typescript/unbound-method -- Preserve the real Worker receiver.
    const postMessage = Worker.prototype.postMessage;
    const capture = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request: SqliteWorkerRequest,
      transferList,
    ) {
      const starts =
        request.type === "execute" && deserialize(request.input).type === "cron.schedulerStart";
      postMessage.call(this, request, transferList);
      if (starts && !workers.includes(this)) {
        workers.push(this);
      }
    });
    try {
      await cron.start();
      // Keep this slot live, rather than a downtime miss that startup deliberately defers.
      cron.pauseScheduling();
      const job = await cron.add({
        name: "recovered-long-running-job",
        enabled: true,
        deleteAfterRun: true,
        schedule: { kind: "at", at: new Date(Date.now()).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "synthetic held startup run" },
      });
      expect(workers).toHaveLength(1);
      await workers[0]!.terminate();
      cron.resumeScheduling();
      await withinTest(executing.promise, signal);
      expect(workers).toHaveLength(2);
      if (outcome === "stop-during-launch") {
        await withinTest(reconnected.promise, signal);
        expect(startupReturned).toBe(true);
        expect(stoppedDrain).toBeDefined();
        expect(stoppedDrainSettled).toBe(false);
        expect(completed).toBe(false);
        finishRun.resolve();
        await withinTest(stoppedDrain!, signal);
        expect(completed).toBe(true);
        expect(runSessionEvent).toHaveBeenCalledOnce();
      } else {
        // Startup has committed and launched real work. Losing the replacement must not
        // stop timer recovery until that potentially long-running work completes.
        await workers[1]!.terminate();
        await vi.waitFor(
          () => {
            expect(workers).toHaveLength(3);
            expect(
              log.info.mock.calls.filter(
                ([, message]) => message === "cron: scheduler reconnected after native worker loss",
              ),
            ).toHaveLength(2);
          },
          { timeout: 3_000 },
        );
        expect(completed).toBe(false);
        expect(runSessionEvent).toHaveBeenCalledOnce();
        finishRun.resolve();
        await runQueue.waitForCronRunQueue(state);
        expect(runSessionEvent).toHaveBeenCalledOnce();
        expect(
          (await cron.list({ includeDisabled: true })).some((entry) => entry.id === job.id),
        ).toBe(false);
      }
    } finally {
      finishRun.resolve();
      finishStartup.resolve();
      launchBoundary?.mockRestore();
      capture.mockRestore();
      cron.stop();
      await state.schedulerDrain;
      await scheduler.stop();
    }
  },
);
