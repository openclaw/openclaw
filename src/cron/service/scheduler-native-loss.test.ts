import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { setupCronRegressionFixtures } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createCronServiceWithStateForTest, createNoopLogger } from "../service.test-harness.js";
import { waitForCronRunQueue } from "./run-queue.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-native-loss-" });

for (const loseReplacement of [false, true]) {
  it(`recovers native scheduler loss and delivers exactly once (replacement also lost: ${loseReplacement})`, async ({
    signal,
  }) => {
    vi.useRealTimers();
    const { storePath } = fixtures.makeStorePath();
    const scheduler = createTestGatewayScheduler("fake-timers");
    const delivered = createDeferred();
    const runSessionEvent = vi.fn(async () => {
      delivered.resolve();
      return { status: "ok" as const };
    });
    const { cron, state } = createCronServiceWithStateForTest({
      scheduler,
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      runSessionEvent,
      runIsolatedAgentJob: vi.fn(),
    });
    const workers: Worker[] = [];
    // Observe and interrupt the real transport, retaining the scheduler and database owners.
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
        if (workers.length === 2 && loseReplacement) {
          void this.terminate();
        }
      }
    });
    try {
      await cron.start();
      const job = await cron.add({
        name: "native-loss-once",
        enabled: true,
        deleteAfterRun: true,
        schedule: { kind: "at", at: new Date(Date.now() + 2_000).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "synthetic recovery" },
      });
      const original = workers[0];
      expect(original).toBeInstanceOf(Worker);
      await original!.terminate();
      expect(original!.threadId).toBe(-1);
      await vi.waitFor(() => expect(workers).toHaveLength(loseReplacement ? 3 : 2), {
        timeout: 3_000,
      });
      await withinTest(delivered.promise, signal);
      await waitForCronRunQueue(state);
      expect(runSessionEvent).toHaveBeenCalledOnce();
      expect(
        (await cron.list({ includeDisabled: true })).some((entry) => entry.id === job.id),
      ).toBe(false);
    } finally {
      capture.mockRestore();
      cron.stop();
      await state.schedulerDrain;
      await scheduler.stop();
    }
  }, 10_000);
}
