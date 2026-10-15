import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { CronJob } from "../types.js";
import { createCronServiceState, type CronServiceDeps } from "./state.js";
import { executeJobCore } from "./timer-execution.js";

type RunSessionEvent = NonNullable<CronServiceDeps["runSessionEvent"]>;

function createHarness(runSessionEvent: RunSessionEvent) {
  const state = createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    cronEnabled: true,
    storePath: "unused-cron-wake-owner.json",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    enqueueSystemEvent: vi.fn(),
    runSessionEvent,
    runIsolatedAgentJob: vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async () => ({
      status: "ok",
    })),
  });
  const job: CronJob = {
    id: "reminder",
    name: "reminder",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "systemEvent", text: "  check pending work  " },
    sessionTarget: "main",
    wakeMode: "now",
    state: {},
  };
  return { state, job };
}

it("retains the ordinary session owner's delivery outcome for a scheduled main turn", async () => {
  const result = {
    status: "ok",
    summary: "pending work completed",
    executionStarted: true,
    delivered: false,
    deliveryAttempted: true,
    deliveryError: "topic unavailable",
    sessionId: "session-1",
    sessionKey: "agent:main:main",
  } as const;
  const runSessionEvent = vi.fn<RunSessionEvent>(async () => result);
  const { state, job } = createHarness(runSessionEvent);

  await expect(executeJobCore(state, job)).resolves.toMatchObject(result);

  expect(runSessionEvent).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ job, text: "check pending work" }),
  );
  expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
  expect(state.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
});

it("does not hand off a scheduled session turn cancelled during occurrence revalidation", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const runSessionEvent = vi.fn<RunSessionEvent>(async () => ({ status: "ok" }));
  const { state, job } = createHarness(runSessionEvent);
  const controller = new AbortController();
  const pending = executeJobCore(state, job, controller.signal, {
    assertRunCurrent: async () => {
      entered.resolve();
      await release.promise;
    },
  });

  await entered.promise;
  controller.abort(new Error("occurrence cancelled"));
  release.resolve();

  await expect(pending).resolves.toMatchObject({ status: "error", error: "occurrence cancelled" });
  expect(runSessionEvent).not.toHaveBeenCalled();
  expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
});

it("keeps cancellation authority live after the ordinary session owner takes custody", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const runSessionEvent = vi.fn<RunSessionEvent>(async (request) => {
    entered.resolve();
    await release.promise;
    request.assertCurrent();
    return { status: "ok" };
  });
  const { state, job } = createHarness(runSessionEvent);
  const controller = new AbortController();
  const pending = executeJobCore(state, job, controller.signal);

  await entered.promise;
  controller.abort(new Error("occurrence cancelled"));
  release.resolve();

  await expect(pending).rejects.toThrow("occurrence cancelled");
  expect(runSessionEvent).toHaveBeenCalledOnce();
});
