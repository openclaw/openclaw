import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { setupCronRegressionFixtures } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { SqliteWorkerReply, SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
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
    const expectedStarts = loseReplacement ? 3 : 2;
    const requiredStarts = createDeferred();
    const runSessionEvent = vi.fn(async () => {
      delivered.resolve();
      return { status: "ok" as const };
    });
    const startedAt = performance.now();
    const events: { elapsedMs: number; phase: string; worker?: number; ok?: boolean }[] = [];
    let droppedEvents = 0;
    const record = (phase: string, worker?: number, ok?: boolean) => {
      if (events.length === 64) {
        events.shift();
        droppedEvents += 1;
      }
      events.push({ elapsedMs: performance.now() - startedAt, phase, worker, ok });
    };
    const log = createNoopLogger();
    log.warn.mockImplementation((_fields, message) => {
      if (message === "cron: worker recovery failed") {
        record("recovery.failed");
      }
    });
    log.info.mockImplementation((_fields, message) => {
      if (message === "cron: scheduler reconnected after native worker loss") {
        record("recovery.reconnected");
      }
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
    const workers: Worker[] = [];
    const observed = new Map<Worker, { id: number; pending: Map<number, string> }>();
    const removeListeners: (() => void)[] = [];
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
      if (request.type === "open" || starts) {
        let entry = observed.get(this);
        if (!entry) {
          const id = observed.size + 1;
          const pending = new Map<number, string>();
          entry = { id, pending };
          observed.set(this, entry);
          const reply = (result: SqliteWorkerReply) => {
            const phase = pending.get(result.id);
            if (phase) {
              pending.delete(result.id);
              record(phase + ".reply", id, result.ok);
            }
          };
          const exit = () => record("native.exit", id);
          this.on("message", reply);
          this.once("exit", exit);
          removeListeners.push(() => {
            this.off("message", reply);
            this.off("exit", exit);
          });
        }
        const phase = starts ? "schedulerStart" : "open";
        entry.pending.set(request.id, phase);
      }
      postMessage.call(this, request, transferList);
      const entry = observed.get(this);
      if ((request.type === "open" || starts) && entry) {
        record(starts ? "schedulerStart.sent" : "open.sent", entry.id);
      }
      if (starts && !workers.includes(this)) {
        workers.push(this);
        if (workers.length === expectedStarts) {
          requiredStarts.resolve();
        }
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
      record("recovery.wait");
      try {
        // Native startup shares the test deadline; a separate probe timeout rejects healthy recovery.
        await withinTest(requiredStarts.promise, signal);
        expect(workers).toHaveLength(expectedStarts);
      } catch (error) {
        // Transport replies do not prove lease admission; native exits do not prove callback delivery.
        console.error(
          "[cron-native-loss]",
          JSON.stringify({
            elapsedMs: performance.now() - startedAt,
            expectedStarts,
            observedStarts: workers.length,
            droppedEvents,
            events,
          }),
        );
        throw error;
      }
      await withinTest(delivered.promise, signal);
      await waitForCronRunQueue(state);
      expect(runSessionEvent).toHaveBeenCalledOnce();
      expect(
        (await cron.list({ includeDisabled: true })).some((entry) => entry.id === job.id),
      ).toBe(false);
    } finally {
      for (const remove of removeListeners) {
        remove();
      }
      capture.mockRestore();
      cron.stop();
      await state.schedulerDrain;
      await scheduler.stop();
    }
  }, 10_000);
}
