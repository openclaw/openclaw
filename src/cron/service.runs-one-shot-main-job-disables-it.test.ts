import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { cronTestDeps, cronTestInput } from "./service.fixture-builders.test-support.js";
import type { CronEvent } from "./service.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJobCreate } from "./types.js";

const { makeStorePath } = setupCronServiceSuite({ prefix: "cron-one-shot-" });
const atMs = Date.parse("2025-12-13T00:00:02.000Z");
const mainJob = (overrides: Partial<CronJobCreate> = {}) =>
  cronTestInput({
    name: "one-shot",
    schedule: { kind: "at", at: new Date(atMs).toISOString() },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "hello" },
    ...overrides,
  });
const isolatedJob = (overrides: Partial<CronJobCreate> = {}) =>
  mainJob({
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "do it" },
    delivery: { mode: "announce" },
    ...overrides,
  });

async function fixture(
  options: Partial<Pick<CronServiceDeps, "runIsolatedAgentJob" | "runSessionEvent" | "nowMs">> = {},
) {
  const store = await makeStorePath();
  const clock = createGatewaySchedulerClock(Date.now());
  const finished = createDeferred<CronEvent>();
  const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(
    options.runSessionEvent ?? (async () => ({ status: "ok" })),
  );
  const deps = cronTestDeps({
    ...options,
    storePath: store.storePath,
    runSessionEvent,
    scheduler: createTestGatewayScheduler(clock.clock),
    nowMs: options.nowMs,
    onEvent: (event) => {
      if (event.action === "finished") {
        finished.resolve(event);
      }
    },
  });
  let owner = createCronServiceWithStateForTest(deps);
  await owner.cron.start();
  const tick = async (at: number) => {
    clock.setTime(at);
    await onTimer(owner.state);
  };
  return {
    deps,
    tick,
    get cron() {
      return owner.cron;
    },
    async run(input: CronJobCreate) {
      const job = await owner.cron.add(input);
      expect(job.state.nextRunAtMs).toBe(atMs);
      await tick(atMs);
      return { job, event: await finished.promise };
    },
    history: (jobId: string) =>
      readCronRunHistoryPageForTests({ storeKey: cronStoreKey(store.storePath), jobId }).entries,
    async restart(scheduler = createTestGatewayScheduler(clock.clock)) {
      owner.cron.stop();
      await owner.cron.waitForIdle();
      owner = createCronServiceWithStateForTest({ ...deps, scheduler });
      await owner.cron.start();
    },
    async [Symbol.asyncDispose]() {
      await owner.cron.status();
      owner.cron.stop();
      await owner.cron.waitForIdle();
      await store.cleanup();
    },
  };
}

it("disables a retained one-shot after success and does not replay it when re-enabled", async () => {
  await using f = await fixture();
  const { job } = await f.run(mainJob({ deleteAfterRun: false }));
  expect(f.cron.getJob(job.id)?.enabled).toBe(false);
  expect(f.deps.enqueueSystemEvent).not.toHaveBeenCalled();
  expect((await f.cron.update(job.id, { enabled: true })).state.nextRunAtMs).toBeUndefined();
  await f.tick(atMs + 1_000);
  expect(f.deps.runSessionEvent).toHaveBeenCalledOnce();
});

it.each([
  ["default delivery failure", undefined, false, undefined, "failed"],
  ["best-effort delivery failure", true, false, undefined, "succeeded"],
  ["unknown delivery", undefined, true, undefined, "unknown"],
  ["silent suppression", false, false, "silent", "succeeded"],
] as const)(
  "cleans up %s once across restart",
  async (_name, bestEffort, unknown, reason, completion) => {
    const run = vi.fn(async () => ({
      status: "ok" as const,
      summary: "payload completed",
      delivered: unknown ? undefined : false,
      deliveryError: unknown || reason ? undefined : "delivery rejected",
      deliverySuppressionReason: reason,
    }));
    await using f = await fixture({ runIsolatedAgentJob: run });
    const { job, event } = await f.run(isolatedJob({ delivery: { mode: "announce", bestEffort } }));
    expect(event).toMatchObject({
      status: "ok",
      completionStatus: completion,
      deliveryStatus: unknown ? "unknown" : "not-delivered",
      nextRunAtMs: undefined,
      ...(reason ? { deliverySuppressionReason: reason } : {}),
    });
    const expectRetained = () => {
      const retained = f.cron.getJob(job.id);
      if (completion === "succeeded") {
        expect(retained).toBeUndefined();
      } else {
        expect(retained).toMatchObject({
          enabled: false,
          state: { lastRunStatus: "ok", consecutiveErrors: 0 },
        });
      }
      expect(retained?.state.nextRunAtMs).toBeUndefined();
    };
    expectRetained();
    await f.restart();
    await f.tick(atMs + 60_000);
    expectRetained();
    expect(run).toHaveBeenCalledOnce();
    expect(f.deps.enqueueSystemEvent).not.toHaveBeenCalled();
  },
);

it("records a refused main-session event as one failure without enqueuing a replay", async () => {
  await using f = await fixture({
    runSessionEvent: async () => ({
      status: "error",
      error: "session admission refused",
      executionStarted: false,
    }),
  });
  const job = await f.cron.add(
    mainJob({ schedule: { kind: "at", at: new Date(1).toISOString() } }),
  );
  await f.cron.run(job.id, "force");
  expect(f.deps.enqueueSystemEvent).not.toHaveBeenCalled();
  expect(f.deps.enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("auto-disabled"),
    expect.objectContaining({ contextKey: `cron:${job.id}:auto-disabled` }),
  );
  expect(f.cron.getJob(job.id)?.state).toMatchObject({
    lastRunStatus: "error",
    lastError: "session admission refused",
    autoDisabled: { reason: "consecutive-failures", consecutiveErrors: 1 },
  });
  expect(f.history(job.id)).toMatchObject([{ status: "error", completionStatus: "failed" }]);
});

it("consumes a scratch-empty one-shot without replaying it after restart", async () => {
  let now = atMs;
  await using f = await fixture({ nowMs: () => now });
  const job = await f.cron.add(
    mainJob({
      payload: { kind: "agentTurn", message: "Check the scratch", skipIfScratchEmpty: true },
    }),
  );
  await f.cron.writeScratch(job.id, { content: "" });
  await f.cron.run(job.id, "due");
  expect(f.cron.getJob(job.id)).toMatchObject({
    enabled: false,
    state: {
      lastStatus: "skipped",
      lastError: undefined,
      consecutiveSkipped: 1,
      nextRunAtMs: undefined,
    },
  });
  now += 90_000;
  await f.restart(createTestGatewayScheduler());
  await f.cron.writeScratch(job.id, { content: "Check the newly populated scratch" });
  await f.tick(now);
  expect(f.deps.runSessionEvent).not.toHaveBeenCalled();
  expect(f.deps.enqueueSystemEvent).not.toHaveBeenCalled();
  expect(f.history(job.id)).toMatchObject([
    { status: "skipped", summary: "Automation scratch is explicitly empty" },
  ]);
});

it.each([false, true])(
  "retries lifecycle claim conflicts only before execution starts (started=%s)",
  async (executionStarted) => {
    const run = vi.fn(async () => ({
      status: "error" as const,
      summary: "last output",
      executionStarted,
      error: 'Session "agent:main:cron:job-1" changed while starting work. Retry.',
    }));
    await using f = await fixture({ runIsolatedAgentJob: run });
    const { job, event } = await f.run(isolatedJob());
    expect(event).toMatchObject({ jobId: job.id, status: "error" });
    const stored = f.cron.getJob(job.id);
    expect(stored).toMatchObject({ enabled: !executionStarted, state: { consecutiveErrors: 1 } });
    if (executionStarted) {
      expect(stored?.state.autoDisabled).toMatchObject({
        reason: "consecutive-failures",
        consecutiveErrors: 1,
      });
      expect(stored?.state.nextRunAtMs).toBeUndefined();
      expect(f.deps.enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('Automation "one-shot" failed 1 times'),
        expect.objectContaining({ contextKey: `cron:${job.id}:failure-alert` }),
      );
    } else {
      expect(stored?.state.nextRunAtMs).toBeTypeOf("number");
      expect(f.deps.enqueueSystemEvent).not.toHaveBeenCalled();
    }
    expect(run).toHaveBeenCalledOnce();
  },
);
