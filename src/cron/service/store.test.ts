import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-store-seam",
});

describe("cron service store seam coverage", () => {
  it("loads, normalizes legacy stored jobs, recomputes next runs, and persists the migrated shape", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "legacy-current-job",
              name: "legacy current job",
              enabled: true,
              createdAtMs: now - 60_000,
              updatedAtMs: now - 60_000,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "current",
              wakeMode: "next-heartbeat",
              message: "legacy message-only payload",
              provider: "telegram",
              to: "123",
              deliver: true,
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state);

    const job = state.store?.jobs[0];
    expect(job).toBeDefined();
    expect(job?.sessionTarget).toBe("isolated");
    expect(job?.payload.kind).toBe("agentTurn");
    if (job?.payload.kind === "agentTurn") {
      expect(job.payload.message).toBe("legacy message-only payload");
      expect(job.payload.channel).toBeUndefined();
      expect(job.payload.to).toBeUndefined();
      expect(job.payload.deliver).toBeUndefined();
    }
    expect(job?.delivery).toMatchObject({
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
    expect(job?.state.nextRunAtMs).toBe(now);

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    const persistedJob = persisted.jobs[0];
    expect(persistedJob?.message).toBeUndefined();
    expect(persistedJob?.provider).toBeUndefined();
    expect(persistedJob?.to).toBeUndefined();
    expect(persistedJob?.deliver).toBeUndefined();
    expect(persistedJob?.payload).toMatchObject({
      kind: "agentTurn",
      message: "legacy message-only payload",
    });
    expect(persistedJob?.delivery).toMatchObject({
      mode: "announce",
      channel: "telegram",
      to: "123",
    });

    const firstMtime = state.storeFileMtimeMs;
    expect(typeof firstMtime).toBe("number");

    await persist(state);
    expect(typeof state.storeFileMtimeMs).toBe("number");
    expect((state.storeFileMtimeMs ?? 0) >= (firstMtime ?? 0)).toBe(true);
  });
});
