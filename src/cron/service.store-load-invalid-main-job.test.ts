import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStoreKey } = createCronStoreHarness({ prefix: "openclaw-cron-row-store-" });
installCronTestHooks({ logger: noopLogger });

describe("CronService store load", () => {
  it("skips invalid main jobs with agentTurn payloads loaded from SQLite", async () => {
    const { storeKey } = await makeStoreKey();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();

    const job = {
      id: "job-1",
      enabled: true,
      createdAtMs: Date.parse("2025-12-13T00:00:00.000Z"),
      updatedAtMs: Date.parse("2025-12-13T00:00:00.000Z"),
      schedule: { kind: "at", at: "2025-12-13T00:00:01.000Z" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "bad" },
      state: {},
      name: "bad",
    } satisfies CronJob;

    await writeCronStoreSnapshot({ storeKey, jobs: [job] });

    const cron = new CronService({
      storeKey,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await cron.run("job-1", "due");

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs[0]?.state.lastStatus).toBe("skipped");
    expect(jobs[0]?.state.lastError).toMatch(/main cron jobs require payload\.kind/i);

    cron.stop();
  });
});
