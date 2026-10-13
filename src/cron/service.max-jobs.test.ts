import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { heartbeatMonitorAddOptions } from "./heartbeat-monitor.js";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";
import { loadCronStore } from "./store.js";
import type { CronJobCreate } from "./types.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-max-jobs-" });
installCronTestHooks({ logger });
const services = new Set<CronService>();
afterEach(() => {
  for (const service of services) {
    service.stop();
  }
  services.clear();
});
// What the Gateway `cron.add` method passes; in-process callers omit it.
const asClient = { enforceJobLimit: true };

async function startCron(maxJobs?: number) {
  const { storePath } = await makeStorePath();
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: true,
    ...(maxJobs === undefined ? {} : { cronConfig: { maxJobs } }),
    defaultAgentId: "main",
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  services.add(cron);
  await cron.start();
  return { cron, storePath };
}

function reminder(name: string, overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: name },
    ...overrides,
  };
}

async function storedNames(storePath: string) {
  return (await loadCronStore(storePath)).jobs.map((job) => job.name).toSorted();
}

describe("cron.maxJobs", () => {
  it("refuses a client create at the limit, counting disabled jobs, until one is removed", async () => {
    const { cron, storePath } = await startCron(2);
    const first = await cron.add(reminder("first"), asClient);
    await cron.add(reminder("paused", { enabled: false }), asClient);

    await expect(cron.add(reminder("third"), asClient)).rejects.toThrow(
      "cron job limit reached: 2 of 2 jobs allowed by cron.maxJobs already exist; remove a job or update an existing one instead of adding another",
    );
    expect(await storedNames(storePath)).toEqual(["first", "paused"]);

    await cron.remove(first.id);
    await cron.add(reminder("third"), asClient);
    expect(await storedNames(storePath)).toEqual(["paused", "third"]);
  });

  it("does not treat re-declaring or updating an existing job as a new job", async () => {
    const { cron } = await startCron(1);
    const declared = reminder("digest", { declarationKey: "ops:digest" });
    const created = await cron.add(declared, asClient);

    await expect(
      cron.add({ ...declared, schedule: { kind: "every", everyMs: 120_000 } }, asClient),
    ).resolves.toMatchObject({ id: created.id, created: false, updated: true });
    await expect(cron.update(created.id, { enabled: false })).resolves.toMatchObject({
      enabled: false,
    });
    await expect(
      cron.add(reminder("other", { declarationKey: "ops:other" }), asClient),
    ).rejects.toThrow(/^cron job limit reached: 1 of 1 /);
  });

  it("counts jobs that plugins create in-process but never refuses them", async () => {
    const { cron, storePath } = await startCron(1);
    await cron.add(reminder("client"), asClient);
    await cron.add(reminder("plugin-managed", { declarationKey: "plugin:managed" }));

    expect(await storedNames(storePath)).toEqual(["client", "plugin-managed"]);
    await expect(cron.add(reminder("second client"), asClient)).rejects.toThrow(
      /^cron job limit reached: 2 of 1 /,
    );
  });

  it("does not count system-owned heartbeat monitors", async () => {
    const { cron, storePath } = await startCron(1);
    await cron.add(
      {
        declarationKey: "heartbeat:main",
        name: "heartbeat-main",
        agentId: "main",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "heartbeat" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      },
      heartbeatMonitorAddOptions("main"),
    );
    await cron.add(reminder("first"), asClient);

    expect(await storedNames(storePath)).toEqual(["first", "heartbeat-main"]);
    await expect(cron.add(reminder("second"), asClient)).rejects.toThrow(
      /^cron job limit reached: 1 of 1 /,
    );
  });

  it("keeps client creates unbounded when maxJobs is unset", async () => {
    const { cron, storePath } = await startCron();
    for (const name of ["a", "b", "c"]) {
      await cron.add(reminder(name), asClient);
    }
    expect(await storedNames(storePath)).toEqual(["a", "b", "c"]);
  });
});
