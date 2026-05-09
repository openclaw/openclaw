import { describe, expect, it, vi } from "vitest";
import { writeCronStoreSnapshot } from "./service.issue-regressions.test-helpers.js";
import { CronService } from "./service.js";
import { createCronStoreHarness, createNoopLogger } from "./service.test-harness.js";
import { loadCronStore } from "./store.js";

const noopLogger = createNoopLogger();
const { makeStoreKey } = createCronStoreHarness({ prefix: "openclaw-cron-issue-35195-" });

describe("cron SQLite edit persistence", () => {
  it("persists edits in SQLite across restart", async () => {
    const { storeKey } = await makeStoreKey();
    const base = Date.now();

    await writeCronStoreSnapshot(storeKey, [
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
      storeKey,
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

    const afterEdit = await loadCronStore(storeKey);
    expect(afterEdit.jobs[0]?.payload).toMatchObject({
      kind: "systemEvent",
      text: "edited",
    });

    service.stop();
    const service2 = new CronService({
      storeKey,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await service2.start();

    const afterRestart = await loadCronStore(storeKey);
    expect(afterRestart.jobs[0]?.payload).toMatchObject({
      kind: "systemEvent",
      text: "edited",
    });

    service2.stop();
  });
});
