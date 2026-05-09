import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { writeCronStoreSnapshot } from "./service.issue-regressions.test-helpers.js";
import { CronService } from "./service.js";
import { createCronStoreHarness, createNoopLogger } from "./service.test-harness.js";
import { loadCronStore } from "./store.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-issue-35195-" });

describe("cron SQLite edit persistence", () => {
  it("persists edits in SQLite without creating legacy backup files", async () => {
    const store = await makeStorePath();
    const base = Date.now();

    await writeCronStoreSnapshot(store.storePath, [
      {
        id: "job-35195",
        name: "job-35195",
        enabled: true,
        createdAtMs: base,
        updatedAtMs: base,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: base },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        state: {},
      },
    ]);

    const service = new CronService({
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await service.start();

    await service.update("job-35195", {
      payload: { kind: "systemEvent", text: "edited" },
    });

    const afterEdit = await loadCronStore(store.storePath);
    expect(afterEdit.jobs[0]?.payload).toMatchObject({
      kind: "systemEvent",
      text: "edited",
    });
    await expect(fs.stat(`${store.storePath}.bak`)).rejects.toThrow();
    await expect(fs.stat(store.storePath)).rejects.toThrow();

    service.stop();
    const service2 = new CronService({
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await service2.start();

    const afterRestart = await loadCronStore(store.storePath);
    expect(afterRestart.jobs[0]?.payload).toMatchObject({
      kind: "systemEvent",
      text: "edited",
    });
    await expect(fs.stat(`${store.storePath}.bak`)).rejects.toThrow();

    service2.stop();
    await store.cleanup();
  });
});
