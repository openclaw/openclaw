import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeCronStoreSnapshot } from "./service.issue-regressions.test-helpers.js";
import { CronService } from "./service.js";
import { createCronStoreHarness, createNoopLogger } from "./service.test-harness.js";
import { loadCronStore } from "./store.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-issue-35195-" });

describe("cron backup timing for edit", () => {
  it("keeps .bak as the pre-edit store even after later normalization persists", async () => {
    const store = await makeStorePath();
    const base = Date.now();

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
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
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await service.start();

    const beforeEditRaw = await fs.readFile(`${store.storePath}.migrated`, "utf-8");

    await service.update("job-35195", {
      payload: { kind: "systemEvent", text: "edited" },
    });

    const archivedRaw = await fs.readFile(`${store.storePath}.migrated`, "utf-8");
    expect(JSON.parse(archivedRaw)).toEqual(JSON.parse(beforeEditRaw));

    const persistedAfterEdit = await loadCronStore(store.storePath);
    const normalizedJob = {
      ...persistedAfterEdit.jobs[0],
      payload: {
        ...persistedAfterEdit.jobs[0]?.payload,
        channel: "forum",
      },
    };

    await writeCronStoreSnapshot(store.storePath, [normalizedJob]);

    service.stop();
    const service2 = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await service2.start();

    const archivedAfterNormalize = await fs.readFile(`${store.storePath}.migrated`, "utf-8");
    expect(JSON.parse(archivedAfterNormalize)).toEqual(JSON.parse(beforeEditRaw));

    service2.stop();
    await store.cleanup();
  });
});
