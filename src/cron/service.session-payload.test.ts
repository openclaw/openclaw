import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { CronEvent } from "./service.js";
import {
  createStartedCronServiceWithFinishedBarrier,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import type { CronRunOutcome } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-session-payload-" });

describe("ordinary session payload settlement", () => {
  it.each(["ok", "error"] as const)(
    "records %s only after the shared session turn settles",
    async (status) => {
      const store = await makeStorePath();
      const entered = createDeferred();
      const child = createDeferred<CronRunOutcome>();
      const events: CronEvent[] = [];
      const { cron, enqueueSystemEvent, enqueueSessionEvent, runSessionEvent } =
        createStartedCronServiceWithFinishedBarrier({
          scheduler: createTestGatewayScheduler(),
          storePath: store.storePath,
          logger,
          runSessionEvent: async () => {
            entered.resolve();
            return child.promise;
          },
          onEvent: (event) => events.push(event),
        });
      await cron.start();
      const job = await cron.add({
        name: "Check the inbox",
        agentId: "main",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentTurn", message: "Check urgent inbox items" },
        sessionTarget: "main",
        wakeMode: "now",
        delivery: { mode: "none" },
      });
      const running = cron.run(job.id, "force");
      try {
        await entered.promise;
        expect(runSessionEvent).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            job: expect.objectContaining({ id: job.id }),
            text: "Check urgent inbox items",
            abortSignal: expect.any(AbortSignal),
          }),
        );
        expect(events.some((event) => event.action === "finished")).toBe(false);
        expect(cron.getJob(job.id)?.state.runningAtMs).toEqual(expect.any(Number));
        child.resolve({ status, ...(status === "error" ? { error: "provider unavailable" } : {}) });
        await expect(running).resolves.toMatchObject({ ok: true, ran: true });
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
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(enqueueSessionEvent).not.toHaveBeenCalled();
      } finally {
        child.resolve({ status: "error", error: "fixture cleanup" });
        await running;
        cron.stop();
      }
    },
  );
});
