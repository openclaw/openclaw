import { vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createNoopLogger } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import type { CronJob } from "./types.js";

export function cronTestDeps(
  overrides: Pick<CronServiceDeps, "storePath"> & Partial<CronServiceDeps>,
): CronServiceDeps {
  return {
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    cronEnabled: true,
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...overrides,
  };
}

export function cronTestJob(overrides: Pick<CronJob, "id"> & Partial<CronJob>): CronJob {
  return {
    name: overrides.id,
    enabled: true,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    state: {},
    ...overrides,
  };
}
