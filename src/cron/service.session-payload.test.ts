import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { CronService, type CronEvent } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import type { CronRunOutcome } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-session-payload-",
  fakeTimers: false,
});

describe("explicit session agent turns", () => {
  it.each(["ok", "error"] as const)(
    "keeps the durable run pending until the session settles with %s",
    async (status) => {
      const { storePath } = await makeStorePath();
      const entered = createDeferred();
      const settlement = createDeferred<CronRunOutcome>();
      const events: CronEvent[] = [];
      const runSessionEvent = vi.fn(async () => {
        entered.resolve();
        return settlement.promise;
      });
      const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async () => ({
        status: "ok",
      }));
      const deps = {
        storePath,
        scheduler: createTestGatewayScheduler(),
        cronEnabled: true,
        defaultAgentId: "main",
        log: logger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
        runSessionEvent,
        onEvent: (event: CronEvent) => events.push(event),
      };
      const cron = new CronService(deps);
      let running: ReturnType<CronService["run"]> | undefined;
      try {
        await cron.start();
        const job = await cron.add({
          name: "Check the project inbox",
          agentId: "main",
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "agentTurn", message: "Check urgent project items" },
          sessionTarget: "session:agent:main:project:inbox",
          wakeMode: "now",
          delivery: { mode: "none" },
        });
        const history = () =>
          readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id })
            .entries;
        running = cron.run(job.id, "force");
        await awaitGateBeforeSettlement(
          entered.promise,
          running,
          "Explicit session run finished without entering runSessionEvent",
        );
        expect(runSessionEvent).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            job: expect.objectContaining({ id: job.id }),
            text: "Check urgent project items",
            abortSignal: expect.any(AbortSignal),
          }),
        );
        expect(runIsolatedAgentJob).not.toHaveBeenCalled();
        expect(
          (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id)?.state,
        ).toMatchObject({
          runningAtMs: expect.any(Number),
          runningReceiptId: expect.any(String),
        });
        expect(history()).toEqual([]);
        expect(events.filter((event) => event.action === "finished")).toEqual([]);

        settlement.resolve({
          status,
          ...(status === "error" ? { error: "provider unavailable" } : {}),
        });
        await expect(running).resolves.toMatchObject({ ok: true, ran: true });
        expect(history()).toMatchObject([{ status }]);
        expect(events.filter((event) => event.action === "finished")).toEqual([
          expect.objectContaining({
            status,
            completionStatus: status === "ok" ? "succeeded" : "failed",
          }),
        ]);
        expect(cron.getJob(job.id)?.state).toMatchObject({
          lastRunStatus: status,
          consecutiveErrors: status === "error" ? 1 : 0,
        });
      } finally {
        settlement.resolve({ status: "error", error: "fixture cleanup" });
        await running;
        cron.stop();
        await cron.waitForIdle();
      }
    },
  );
});
