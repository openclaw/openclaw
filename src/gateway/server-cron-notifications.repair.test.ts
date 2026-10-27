import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const mocks = vi.hoisted(() => ({
  dispatchGatewayLifecycleMethod: vi.fn(async () => {}),
  waitForAgentJob: vi.fn<typeof import("./agent-turn/agent-job.js").waitForAgentJob>(
    async () => ({ status: "ok" }) as never,
  ),
}));

vi.mock("./server-recovery-runtime-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-recovery-runtime-context.js")>()),
  dispatchGatewayLifecycleMethod: mocks.dispatchGatewayLifecycleMethod,
}));

vi.mock("./agent-turn/agent-job.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-turn/agent-job.js")>()),
  waitForAgentJob: mocks.waitForAgentJob,
}));

import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createGatewayCronFailureRepair } from "./server-cron-notifications.js";

async function runRepairAndCaptureBudget(opts: { elapsed: number; wall: number }) {
  let monotonicNow = 1_700_000_000_000;
  vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
  vi.setSystemTime(monotonicNow);

  const dispatch = createDeferred();
  mocks.dispatchGatewayLifecycleMethod.mockReturnValue(dispatch.promise);

  const repair = createGatewayCronFailureRepair({}, undefined);
  const runPromise = repair.runCronFailureRepair({
    jobId: "job-1",
    repairId: "repair-1",
    timeoutMs: 30_000,
    sessionKey: "session:owner",
    message: "repair the failing cron",
  });

  await Promise.resolve();
  await Promise.resolve();

  monotonicNow += opts.elapsed;
  vi.setSystemTime(opts.wall);

  dispatch.resolve();
  await runPromise;

  expect(mocks.dispatchGatewayLifecycleMethod).toHaveBeenCalledTimes(1);
  expect(mocks.waitForAgentJob).toHaveBeenCalledTimes(1);
  return mocks.waitForAgentJob.mock.calls[0]?.[0]?.timeoutMs;
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  vi.clearAllMocks();
  mocks.waitForAgentJob.mockResolvedValue({ status: "ok" } as never);
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
