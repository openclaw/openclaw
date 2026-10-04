import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import { loadCronJobsStore } from "./store.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

const base = Date.parse("2025-12-13T00:00:00.000Z");

function createJob(id: string, schedule: CronJob["schedule"], nextRunAtMs?: number): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: base - 3_600_000,
    updatedAtMs: base - 10_000,
    schedule,
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "tick" },
    delivery: { mode: "none" },
    state: nextRunAtMs === undefined ? {} : { nextRunAtMs },
  };
}

describe("remove() must not drop a due every-job's pending run", () => {
  it("preserves a due sibling while backfilling another enabled sibling on cold-store remove", async () => {
    const store = await makeStorePath();
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        createJob("due-every", { kind: "every", everyMs: 10_000 }, base - 5_000),
        createJob("missing-next", { kind: "cron", expr: "0 9 * * *", tz: "UTC" }),
        createJob("to-remove", { kind: "cron", expr: "0 12 * * *", tz: "UTC" }, base + 3_600_000),
      ],
    });

    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      runSessionEvent: vi.fn(async () => ({ status: "ok" as const })),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    const result = await cron.remove("to-remove");
    expect(result).toEqual({ ok: true, removed: true });

    const persisted = await loadCronJobsStore(store.storePath);
    const byId = new Map(persisted.jobs.map((job) => [job.id, job]));

    expect(byId.has("to-remove")).toBe(false);
    expect(byId.get("due-every")?.state.nextRunAtMs).toBe(base - 5_000);
    expect(byId.get("missing-next")?.state.nextRunAtMs).toBeGreaterThan(base);

    cron.stop();
  });
});
