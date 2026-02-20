import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { createCronStoreHarness, createNoopLogger } from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();

async function waitForFirstJob(
  cron: CronService,
  predicate: (job: CronJob | undefined) => boolean,
) {
  let latest: CronJob | undefined;
  for (let i = 0; i < 30; i++) {
    const jobs = await cron.list({ includeDisabled: true });
    latest = jobs[0];
    if (predicate(latest)) {
      return latest;
    }
    await vi.runOnlyPendingTimersAsync();
  }
  return latest;
}

async function withCronService(
  cronEnabled: boolean,
  run: (params: {
    cron: CronService;
    enqueueSystemEvent: ReturnType<typeof vi.fn>;
    requestHeartbeatNow: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
) {
  const store = await makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeatNow = vi.fn();
  const cron = new CronService({
    storePath: store.storePath,
    cronEnabled,
    log: noopLogger,
    enqueueSystemEvent,
    requestHeartbeatNow,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });

  await cron.start();
  try {
    await run({ cron, enqueueSystemEvent, requestHeartbeatNow });
  } finally {
    cron.stop();
    await store.cleanup();
  }
}

describe("CronService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T00:00:00.000Z"));
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips main jobs with empty systemEvent text", async () => {
    await withCronService(true, async ({ cron, enqueueSystemEvent, requestHeartbeatNow }) => {
      const atMs = Date.parse("2025-12-13T00:00:01.000Z");
      await cron.add({
        name: "empty systemEvent test",
        enabled: true,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "   " },
      });

      vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
      await vi.runOnlyPendingTimersAsync();

      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeatNow).not.toHaveBeenCalled();

      const job = await waitForFirstJob(cron, (current) => current?.state.lastStatus === "skipped");
      expect(job?.state.lastStatus).toBe("skipped");
      expect(job?.state.lastError).toMatch(/non-empty/i);
    });
  });

  it("does not schedule timers when cron is disabled", async () => {
    await withCronService(false, async ({ cron, enqueueSystemEvent, requestHeartbeatNow }) => {
      const atMs = Date.parse("2025-12-13T00:00:01.000Z");
      await cron.add({
        name: "disabled cron job",
        enabled: true,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "hello" },
      });

      const status = await cron.status();
      expect(status.enabled).toBe(false);
      expect(status.nextWakeAtMs).toBeNull();

      vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
      await vi.runOnlyPendingTimersAsync();

      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeatNow).not.toHaveBeenCalled();
      expect(noopLogger.warn).toHaveBeenCalled();
    });
  });

  it("prunes expired cron run sessions on startup even when cron is disabled", async () => {
    const store = await makeStorePath();
    const now = Date.now();
    const rootDir = path.dirname(path.dirname(store.storePath));
    const sessionStorePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(sessionStorePath), { recursive: true });
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify(
        {
          "agent:main:cron:job1": {
            sessionId: "base",
            updatedAt: now,
          },
          "agent:main:cron:job1:run:expired": {
            sessionId: "expired",
            updatedAt: now - 25 * 3_600_000,
          },
          "agent:main:cron:job1:run:fresh": {
            sessionId: "fresh",
            updatedAt: now - 30 * 60_000,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: false,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      sessionStorePath,
    });

    await cron.start();

    const updated = JSON.parse(fs.readFileSync(sessionStorePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(updated["agent:main:cron:job1"]).toBeDefined();
    expect(updated["agent:main:cron:job1:run:fresh"]).toBeDefined();
    expect(updated["agent:main:cron:job1:run:expired"]).toBeUndefined();

    const status = await cron.status();
    expect(status.enabled).toBe(false);
    expect(status.nextWakeAtMs).toBeNull();
    expect(noopLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        storeCount: 1,
        sweptStores: 1,
        totalPruned: 1,
        failedStores: 0,
        elapsedMs: expect.any(Number),
        slowestStorePath: sessionStorePath,
        slowestStoreElapsedMs: expect.any(Number),
      }),
      "cron: startup session reaper metrics",
    );

    cron.stop();
    await store.cleanup();
  });

  it("status reports next wake when enabled", async () => {
    await withCronService(true, async ({ cron }) => {
      const atMs = Date.parse("2025-12-13T00:00:05.000Z");
      await cron.add({
        name: "status next wake",
        enabled: true,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });

      const status = await cron.status();
      expect(status.enabled).toBe(true);
      expect(status.jobs).toBe(1);
      expect(status.nextWakeAtMs).toBe(atMs);
    });
  });
});
