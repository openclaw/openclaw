// Boundary proof: real CronService store + scheduler; no provider or channel send is claimed.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { reconcileHeartbeatMonitorJobs, resolveHeartbeatMonitorPlan } from "./heartbeat-monitor.js";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

const HEARTBEAT_EVERY_MS = 30 * 60_000;

function createService(storePath: string, cronEnabled: boolean) {
  const requestHeartbeatAndWait = vi.fn(async () => ({ status: "ran", durationMs: 1 }) as const);
  const cron = new CronService({
    storePath,
    cronEnabled,
    defaultAgentId: "main",
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    requestHeartbeatAndWait,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  return { cron, requestHeartbeatAndWait };
}

async function seedMonitor(cron: CronService, everyMs: number) {
  const added = await cron.add(
    {
      declarationKey: "heartbeat:main",
      name: "heartbeat-main",
      agentId: "main",
      enabled: true,
      schedule: { kind: "every", everyMs },
      payload: { kind: "heartbeat" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    },
    { enabledExplicit: true, systemOwned: true },
  );
  return "job" in added ? added.job : added;
}

describe("heartbeat monitors are inert while the cron scheduler is off", () => {
  it("plans no enabled monitor when the scheduler is disabled", () => {
    const cfg = {
      agents: { defaults: { heartbeat: { every: "30m" } } },
    } as OpenClawConfig;

    const specs = resolveHeartbeatMonitorPlan(cfg, [], { cronEnabled: false }).specs;

    expect(specs.map((spec) => spec.input.enabled)).toEqual([false]);
  });

  it("converges an enabled monitor row to disabled while the scheduler is off", async () => {
    const cfg = {
      agents: { defaults: { heartbeat: { every: "30m" } } },
    } as OpenClawConfig;
    const enabledInput = resolveHeartbeatMonitorPlan(cfg, [], {}).specs[0]?.input;
    if (!enabledInput) {
      throw new Error("expected a heartbeat monitor spec");
    }
    const existing = {
      ...enabledInput,
      id: "job-main",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      state: { nextRunAtMs: HEARTBEAT_EVERY_MS },
    } as CronJob;

    const plan = resolveHeartbeatMonitorPlan(cfg, [existing], { cronEnabled: false });

    expect(plan.changes).toEqual([
      expect.objectContaining({
        kind: "update",
        agentId: "main",
        input: expect.objectContaining({ enabled: false }),
      }),
    ]);
  });

  it("reconciles the monitor row as disabled through the gateway path", async () => {
    const add = vi.fn(async (input: { enabled?: boolean }) => ({ id: "job-main", ...input }));
    const result = await reconcileHeartbeatMonitorJobs({
      cron: { add, remove: vi.fn(), list: vi.fn(async () => []) } as never,
      cfg: { agents: { defaults: { heartbeat: { every: "30m" } } } } as OpenClawConfig,
      cronEnabled: false,
      logger: noopLogger,
    });

    expect(result).toEqual({ ok: true });
    expect(add.mock.calls[0]?.[0]).toMatchObject({ enabled: false });
  });

  it("never wakes the agent for a persisted due monitor while the scheduler is off", async () => {
    const store = await makeStorePath();
    try {
      const seeded = createService(store.storePath, true);
      await seedMonitor(seeded.cron, 60_000);
      seeded.cron.stop();

      const disabled = createService(store.storePath, false);
      await disabled.cron.start();
      await vi.advanceTimersByTimeAsync(31 * 60_000);

      expect(disabled.requestHeartbeatAndWait).not.toHaveBeenCalled();
      expect((await disabled.cron.list({ includeDisabled: true }))[0]?.enabled).toBe(true);
      disabled.cron.stop();
    } finally {
      await store.cleanup();
    }
  });

  it("still wakes the agent from the same row when the scheduler is on", async () => {
    const store = await makeStorePath();
    try {
      const seeded = createService(store.storePath, true);
      await seedMonitor(seeded.cron, 60_000);
      seeded.cron.stop();

      const enabled = createService(store.storePath, true);
      await enabled.cron.start();
      await vi.advanceTimersByTimeAsync(61_000);

      expect(enabled.requestHeartbeatAndWait).toHaveBeenCalled();
      enabled.cron.stop();
    } finally {
      await store.cleanup();
    }
  });
});
