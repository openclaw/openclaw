// Unit tests for purgeAgentCronJobs — verifies canonical store-path cleanup and error resilience.
import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  loadCronJobsStoreSync: vi.fn(),
  resolveCronJobsStorePath: vi.fn(),
  saveCronJobsStore: vi.fn(),
}));

vi.mock("../store.js", () => ({
  loadCronJobsStoreSync: storeMocks.loadCronJobsStoreSync,
  resolveCronJobsStorePath: storeMocks.resolveCronJobsStorePath,
  saveCronJobsStore: storeMocks.saveCronJobsStore,
}));

import { purgeAgentCronJobs } from "./purge-agent-cron-jobs.js";

describe("purgeAgentCronJobs", () => {
  const storePath = "/tmp/openclaw-cron/jobs.json";

  beforeEach(() => {
    storeMocks.resolveCronJobsStorePath.mockReset();
    storeMocks.loadCronJobsStoreSync.mockReset();
    storeMocks.saveCronJobsStore.mockReset();

    storeMocks.resolveCronJobsStorePath.mockReturnValue(storePath);
  });

  it("removes jobs matching the agent id and persists through the canonical store path", async () => {
    storeMocks.loadCronJobsStoreSync.mockReturnValue({
      version: 1,
      jobs: [
        { id: "j1", agentId: "ops" },
        { id: "j2", agentId: "main" },
        { id: "j3", agentId: "ops" },
      ],
    });

    await purgeAgentCronJobs("ops");

    expect(storeMocks.resolveCronJobsStorePath).toHaveBeenCalledOnce();
    expect(storeMocks.loadCronJobsStoreSync).toHaveBeenCalledWith(storePath);

    const savedStore = storeMocks.saveCronJobsStore.mock.calls[0][1];
    expect(savedStore.jobs).toHaveLength(1);
    expect(savedStore.jobs[0].id).toBe("j2");
    expect(storeMocks.saveCronJobsStore).toHaveBeenCalledOnce();
  });

  it("does not persist when no matching jobs exist", async () => {
    storeMocks.loadCronJobsStoreSync.mockReturnValue({
      version: 1,
      jobs: [{ id: "j1", agentId: "main" }],
    });

    await purgeAgentCronJobs("ops");

    expect(storeMocks.saveCronJobsStore).not.toHaveBeenCalled();
  });

  it("swallows errors when the store cannot be loaded", async () => {
    storeMocks.loadCronJobsStoreSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    await expect(purgeAgentCronJobs("ops")).resolves.toBeUndefined();
    expect(storeMocks.saveCronJobsStore).not.toHaveBeenCalled();
  });

  it("swallows errors when the store cannot be saved", async () => {
    storeMocks.loadCronJobsStoreSync.mockReturnValue({
      version: 1,
      jobs: [{ id: "j1", agentId: "ops" }],
    });
    storeMocks.saveCronJobsStore.mockRejectedValue(new Error("SQLITE_BUSY"));

    await expect(purgeAgentCronJobs("ops")).resolves.toBeUndefined();
  });
});
