import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronFailureRepairRequest } from "../cron/service/state.js";

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

import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createGatewayCronFailureRepair } from "./server-cron-notifications.js";

function makeRequest(overrides: Partial<CronFailureRepairRequest> = {}): CronFailureRepairRequest {
  return {
    jobId: "job-1",
    repairId: "repair-1",
    timeoutMs: 30_000,
    sessionKey: "session:owner",
    message: "repair the failing cron",
    ...overrides,
  };
}

async function runRepairAndCaptureBudget(opts: {
  seedMonotonic: number;
  seedWall: number;
  readMonotonic: number;
  readWall: number;
}) {
  let monotonicNow = opts.seedMonotonic;
  vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
  vi.setSystemTime(opts.seedWall);

  let releaseDispatch: (() => void) | undefined;
  mocks.dispatchGatewayLifecycleMethod.mockReturnValue(
    new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    }),
  );

  const repair = createGatewayCronFailureRepair({} as OpenClawConfig, undefined);
  const runPromise = repair.runCronFailureRepair(makeRequest({ timeoutMs: 30_000 }));

  await Promise.resolve();
  await Promise.resolve();

  monotonicNow = opts.readMonotonic;
  vi.setSystemTime(opts.readWall);

  releaseDispatch?.();
  await runPromise;

  expect(mocks.dispatchGatewayLifecycleMethod).toHaveBeenCalledTimes(1);
  expect(mocks.waitForAgentJob).toHaveBeenCalledTimes(1);
  return mocks.waitForAgentJob.mock.calls[0]?.[0]?.timeoutMs;
}

describe("runGatewayCronFailureRepair deadline", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    mocks.dispatchGatewayLifecycleMethod.mockResolvedValue(undefined);
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
      seedMonotonic: 1_700_000_000_000,
      seedWall: 1_700_000_000_000,
      readMonotonic: 1_700_000_000_010,
      readWall: 1_699_995_000_000,
      expectedBudget: 30_000 - 10,
    },
    {
      name: "does not collapse a healthy repair when the wall clock jumps forward",
      seedMonotonic: 1_700_000_000_000,
      seedWall: 1_700_000_000_000,
      readMonotonic: 1_700_000_000_005,
      readWall: 1_700_060_000_000,
      expectedBudget: 30_000 - 5,
    },
  ])("$name", async ({ seedMonotonic, seedWall, readMonotonic, readWall, expectedBudget }) => {
    const budget = await runRepairAndCaptureBudget({
      seedMonotonic,
      seedWall,
      readMonotonic,
      readWall,
    });
    expect(budget).toBe(expectedBudget);
    expect(budget).toBeGreaterThan(0);
  });
});
