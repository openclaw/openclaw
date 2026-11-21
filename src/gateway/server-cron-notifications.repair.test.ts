import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const mocks = vi.hoisted(() => ({
  enqueueSessionEventForHost: vi.fn(),
  captureCronJobTurnTarget: vi.fn(async () => ({ target: {}, release: () => {} })),
  withTimeout: vi.fn(async (promise: Promise<unknown>, _timeoutMs: number) => await promise),
}));

vi.mock("../auto-reply/reply/session-event-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/reply/session-event-handoff.js")>()),
  enqueueSessionEventForHost: mocks.enqueueSessionEventForHost,
}));

vi.mock("./cron-job-turn-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cron-job-turn-target.js")>()),
  captureCronJobTurnTarget: mocks.captureCronJobTurnTarget,
}));

vi.mock("../infra/fs-safe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/fs-safe.js")>()),
  withTimeout: mocks.withTimeout,
}));

import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createGatewayCronFailureRepair } from "./server-cron-notifications.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

async function runRepairAndCaptureBudget(opts: { elapsed: number; wall: number }) {
  let monotonicNow = 1_700_000_000_000;
  vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
  vi.setSystemTime(monotonicNow);

  const accepted = createDeferred<{ ok: true }>();
  mocks.enqueueSessionEventForHost.mockReturnValue({
    accepted: accepted.promise,
    settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
    cancel: () => true,
  });
  const context = {
    cron: { getJob: () => ({ id: "job-1" }) },
  } as unknown as GatewayRequestContext;

  const repair = createGatewayCronFailureRepair({}, () => context);
  const runPromise = repair.runCronFailureRepair({
    jobId: "job-1",
    repairId: "repair-1",
    timeoutMs: 30_000,
    agentId: "main",
    sessionKey: "agent:main:owner",
    message: "repair the failing cron",
  });

  await vi.waitFor(() => expect(mocks.enqueueSessionEventForHost).toHaveBeenCalledTimes(1));
  monotonicNow += opts.elapsed;
  vi.setSystemTime(opts.wall);

  accepted.resolve({ ok: true });
  await runPromise;

  expect(mocks.withTimeout).toHaveBeenCalledTimes(1);
  return mocks.withTimeout.mock.calls[0]?.[1];
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetGatewayWorkAdmission();
});

it.each([
  {
    name: "does not inflate the remaining budget when the wall clock rolls back",
    elapsed: 10,
    wall: 1_699_995_000_000,
  },
  {
    name: "does not collapse a healthy repair when the wall clock jumps forward",
    elapsed: 5,
    wall: 1_700_060_000_000,
  },
])("$name", async ({ elapsed, wall }) => {
  const budget = await runRepairAndCaptureBudget({ elapsed, wall });
  expect(budget).toBe(30_000 - elapsed);
  expect(budget).toBeGreaterThan(0);
});
