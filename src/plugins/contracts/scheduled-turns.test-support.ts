import { vi } from "vitest";
import type { CronServiceContract } from "../../cron/service-contract.js";
import type { CronJob } from "../../cron/types.js";

export function createMockCronService(
  workflowMocks: {
    cronAdd: CronServiceContract["add"];
    cronListPage: CronServiceContract["listPage"];
    cronRemove: CronServiceContract["remove"];
  },
  makeCronJob: (input: Partial<CronJob> & { id: string }) => CronJob,
): CronServiceContract {
  return {
    readEventSources: vi.fn<CronServiceContract["readEventSources"]>(async () => []),
    runEvent: vi.fn<CronServiceContract["runEvent"]>(async () => ({ kind: "invalidated" })),
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    status: vi.fn(async () => ({
      enabled: true,
      triggersEnabled: true,
      storePath: "/tmp/openclaw-test-cron.json",
      storage: "sqlite" as const,
      sqlitePath: "/tmp/openclaw-test-state/state/openclaw.sqlite",
      jobs: 0,
      nextWakeAtMs: null,
    })),
    list: vi.fn(async () => []),
    listPage: workflowMocks.cronListPage,
    add: workflowMocks.cronAdd,
    update: vi.fn(async (id, patch) => makeCronJob({ id, ...patch })),
    updateWithPrecondition: vi.fn(async (id, patch, precondition) => {
      const job = makeCronJob({ id });
      await precondition(job, Date.now());
      return makeCronJob({ ...job, ...patch });
    }),
    remove: workflowMocks.cronRemove,
    run: vi.fn<CronServiceContract["run"]>(async () => ({
      ok: true,
      ran: false,
      reason: "not-due",
    })),
    enqueueRun: vi.fn<CronServiceContract["enqueueRun"]>(async () => ({
      ok: true,
      ran: false,
      reason: "not-due",
    })),
    getJob: vi.fn(() => undefined),
    readJob: vi.fn(async () => undefined),
    getDefaultAgentId: vi.fn(() => undefined),
    wake: vi.fn(() => ({ ok: true })),
  };
}
