import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { tryGetLegacyDefaultAgentId } from "../../../config/legacy.default-agent-owner.js";
import { validateConfigObjectWithPlugins } from "../../../config/validation.js";
import { materializeLegacyDefaultCronJobOwners as materializeLatestCronOwners } from "../../../cron/legacy-default-agent-owner-migration.js";
import { CronService } from "../../../cron/service.js";
import { loadCronJobsStoreWithConfigJobsReadOnly, saveCronJobsStore } from "../../../cron/store.js";
import type { CronJob } from "../../../cron/types.js";
import { materializeLegacyDefaultCronJobOwners } from "./legacy-repair.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function legacyJob(id: string, sessionKey?: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    ...(sessionKey ? { sessionKey } : {}),
    payload: { kind: "agentTurn", message: id },
    delivery: { mode: "none" },
    state: {},
  };
}

describe("legacy default cron ownership", () => {
  it("persists the retired default only on ownerless jobs", async () => {
    const root = tempDirs.make("openclaw-cron-owner-");
    const storePath = path.join(root, "cron.sqlite");
    await saveCronJobsStore(storePath, {
      version: 1,
      jobs: [
        legacyJob("ownerless"),
        { ...legacyJob("explicit"), agentId: "research" },
        legacyJob("scoped", "agent:scoped:main"),
      ],
    });

    const first = await materializeLegacyDefaultCronJobOwners({
      cfg: { cron: { store: storePath } as never },
      legacyDefaultAgentId: "ops",
    });
    expect(first.changes).toHaveLength(1);
    const loaded = await loadCronJobsStoreWithConfigJobsReadOnly(storePath);
    expect(loaded.store.jobs.map((job) => [job.id, job.agentId])).toEqual([
      ["ownerless", "ops"],
      ["explicit", "research"],
      ["scoped", undefined],
    ]);

    await expect(
      materializeLegacyDefaultCronJobOwners({
        cfg: { cron: { store: storePath } as never },
        legacyDefaultAgentId: "ops",
      }),
    ).resolves.toMatchObject({ changes: [] });
  });

  it("preserves a commit interleaved after a record snapshot was loaded", async () => {
    const root = tempDirs.make("openclaw-cron-owner-interleaved-");
    const storePath = path.join(root, "cron.sqlite");
    const staleRecords = [legacyJob("ownerless")] as unknown as Array<Record<string, unknown>>;
    await saveCronJobsStore(storePath, {
      version: 1,
      jobs: [legacyJob("ownerless"), { ...legacyJob("concurrent"), agentId: "research" }],
    });

    await expect(
      materializeLatestCronOwners({
        storePath,
        legacyDefaultAgentId: "ops",
        records: staleRecords,
      }),
    ).resolves.toMatchObject({ warnings: [] });

    expect(
      (await loadCronJobsStoreWithConfigJobsReadOnly(storePath)).store.jobs.map((job) => [
        job.id,
        job.agentId,
      ]),
    ).toEqual([
      ["ownerless", "ops"],
      ["concurrent", "research"],
    ]);
  });

  it("migrates an ownerless row before normal scheduler startup without Doctor", async () => {
    const root = tempDirs.make("openclaw-cron-owner-startup-");
    const storePath = path.join(root, "cron.sqlite");
    await saveCronJobsStore(storePath, {
      version: 1,
      jobs: [legacyJob("ownerless")],
    });
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      legacyDefaultAgentId: "ops",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    try {
      await cron.start();
      await expect(
        cron.add({
          name: "first post-migration add",
          enabled: true,
          agentId: "ops",
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "new" },
        }),
      ).resolves.toMatchObject({ agentId: "ops" });
      await expect(cron.run("ownerless", "force")).resolves.toMatchObject({ ok: true, ran: true });
      expect(runIsolatedAgentJob).toHaveBeenCalledWith(
        expect.objectContaining({ job: expect.objectContaining({ agentId: "ops" }) }),
      );
      expect(
        (await loadCronJobsStoreWithConfigJobsReadOnly(storePath)).store.jobs[0]?.agentId,
      ).toBe("ops");
    } finally {
      cron.stop();
    }
  });

  it("keeps first-entry cron ownership for a marker-free fleet with a peer binding", async () => {
    const root = tempDirs.make("openclaw-cron-marker-free-owner-");
    const storePath = path.join(root, "cron.sqlite");
    await saveCronJobsStore(storePath, { version: 1, jobs: [legacyJob("ownerless")] });
    const validated = validateConfigObjectWithPlugins(
      {
        agents: { entries: { ops: {}, research: {} } },
        channels: { telegram: { enabled: true } },
        bindings: [{ agentId: "research", match: { channel: "telegram", accountId: "work" } }],
      },
      { pluginValidation: "skip", env: { HOME: root } as NodeJS.ProcessEnv },
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) {
      return;
    }
    const legacyDefaultAgentId = tryGetLegacyDefaultAgentId(validated.config);
    expect(legacyDefaultAgentId).toBe("ops");
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      legacyDefaultAgentId,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    try {
      await cron.start();
      expect(
        (await loadCronJobsStoreWithConfigJobsReadOnly(storePath)).store.jobs[0]?.agentId,
      ).toBe("ops");
    } finally {
      cron.stop();
    }
  });
});
