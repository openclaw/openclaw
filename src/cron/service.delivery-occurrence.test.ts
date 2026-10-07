// Admission hands every run the scheduled occurrence its completion delivery
// belongs to; durable delivery intents key on it.
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronEvent, CronServiceDeps } from "./service/state.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-delivery-occurrence-" });

it("keeps a one-shot retry on its occurrence, even a day later, and gives a forced run its own", async () => {
  const { storePath } = await makeStorePath();
  const clock = createGatewaySchedulerClock(Date.now());
  const occurrences: (number | undefined)[] = [];
  let finished = createDeferred<CronEvent>();
  const runCommandJob: NonNullable<CronServiceDeps["runCommandJob"]> = async ({
    deliveryAttemptFence,
  }) => {
    occurrences.push(deliveryAttemptFence?.occurrenceAtMs);
    return occurrences.length === 1
      ? { status: "error", error: "cron: job execution timed out" }
      : { status: "ok", summary: "reminder" };
  };
  const cron = new CronService({
    storePath,
    scheduler: createTestGatewayScheduler(clock.clock),
    nowMs: clock.clock.now,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
    runCommandJob,
    onEvent: (event) => {
      if (event.action === "finished") {
        finished.resolve(event);
      }
    },
  });
  try {
    await cron.start();
    const atMs = clock.clock.now() + 1_000;
    const job = await cron.add({
      name: "reminder",
      enabled: true,
      deleteAfterRun: false,
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "command", argv: ["/bin/cat"] },
      delivery: { mode: "none" },
    });

    void clock.advanceTo(atMs);
    expect(await finished.promise).toMatchObject({ status: "error" });
    const retryAtMs = (await cron.readJob(job.id))?.state.nextRunAtMs;
    expect(retryAtMs).toBeGreaterThan(atMs);

    // An operator forcing the errored one-shot is a new occurrence, not its retry.
    const forcedAtMs = atMs + 5_000;
    expect(forcedAtMs).toBeLessThan(retryAtMs!);
    void clock.advanceTo(forcedAtMs);
    await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

    // The Gateway stays down past the retry slot for over a day; the persisted
    // retry still runs as the authored occurrence.
    finished = createDeferred<CronEvent>();
    void clock.advanceTo(retryAtMs! + 25 * 60 * 60_000);
    expect(await finished.promise).toMatchObject({ status: "ok" });

    expect(occurrences).toEqual([atMs, forcedAtMs, atMs]);
  } finally {
    cron.stop();
  }
});
