import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-external-reload-",
});

async function bumpStoreMtime(storePath: string, iso: string) {
  const ts = new Date(iso);
  await fs.utimes(storePath, ts, ts);
}

describe("CronService external store reload", () => {
  it("reloads a manually cleared running marker before cron.run", async () => {
    const store = await makeStorePath();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    try {
      await cron.start();
      const job = await cron.add({
        name: "manual recovery",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "run now" },
        delivery: { mode: "none" },
      });

      const internal = cron as unknown as {
        state: {
          store: {
            jobs: Array<{
              id: string;
              state: { runningAtMs?: number };
            }>;
          } | null;
        };
      };
      const inMemoryJob = internal.state.store?.jobs.find((entry) => entry.id === job.id);
      expect(inMemoryJob).toBeDefined();
      inMemoryJob!.state.runningAtMs = Date.now();

      await writeCronStoreSnapshot({
        storePath: store.storePath,
        jobs: [{ ...job, state: { ...job.state, runningAtMs: undefined } }],
      });
      await bumpStoreMtime(store.storePath, "2030-01-01T00:00:00.000Z");

      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("reloads externally deleted jobs for list and run", async () => {
    const store = await makeStorePath();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
    });

    try {
      await cron.start();
      const job = await cron.add({
        name: "manual delete",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "run now" },
        delivery: { mode: "none" },
      });

      await fs.mkdir(path.dirname(store.storePath), { recursive: true });
      await fs.writeFile(
        store.storePath,
        JSON.stringify({ version: 1, jobs: [] }, null, 2),
        "utf-8",
      );
      await bumpStoreMtime(store.storePath, "2030-01-01T00:05:00.000Z");

      await expect(cron.list({ includeDisabled: true })).resolves.toEqual([]);
      await expect(cron.run(job.id, "force")).rejects.toThrow(`unknown cron job id: ${job.id}`);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});
