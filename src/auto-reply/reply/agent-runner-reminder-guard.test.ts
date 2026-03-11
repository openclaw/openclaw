import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronStoreFile } from "../../cron/types.js";

vi.mock("../../cron/store.js", () => ({
  resolveCronStorePath: vi.fn(() => "/tmp/cron/jobs.json"),
  loadCronStore: vi.fn(),
}));

import { loadCronStore } from "../../cron/store.js";
import { hasSessionRelatedCronJobs } from "./agent-runner-reminder-guard.js";

const loadCronStoreMock = vi.mocked(loadCronStore);

function makeStore(
  jobs: Array<{ enabled: boolean; sessionKey?: string; agentId?: string }>,
): CronStoreFile {
  return {
    version: 1,
    jobs: jobs.map((j, i) => ({
      id: `job-${i}`,
      name: `job-${i}`,
      enabled: j.enabled,
      sessionKey: j.sessionKey,
      agentId: j.agentId,
      sessionTarget: "main" as const,
      schedule: { cron: "0 * * * *", tz: "UTC" },
      payload: { kind: "systemEvent" as const, text: "test" },
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      state: {},
    })) as CronStoreFile["jobs"],
  };
}

describe("hasSessionRelatedCronJobs", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns true for a session-bound job matching sessionKey", async () => {
    loadCronStoreMock.mockResolvedValue(makeStore([{ enabled: true, sessionKey: "agent:main" }]));

    const result = await hasSessionRelatedCronJobs({ sessionKey: "agent:main" });
    expect(result).toBe(true);
  });

  it("returns false for a session-bound job with different sessionKey", async () => {
    loadCronStoreMock.mockResolvedValue(makeStore([{ enabled: true, sessionKey: "agent:other" }]));

    const result = await hasSessionRelatedCronJobs({ sessionKey: "agent:main" });
    expect(result).toBe(false);
  });

  it("returns true for an isolated job matching agentId", async () => {
    loadCronStoreMock.mockResolvedValue(makeStore([{ enabled: true, agentId: "main" }]));

    const result = await hasSessionRelatedCronJobs({ sessionKey: "agent:main", agentId: "main" });
    expect(result).toBe(true);
  });

  it("returns false for an isolated job with mismatched agentId", async () => {
    loadCronStoreMock.mockResolvedValue(makeStore([{ enabled: true, agentId: "ops" }]));

    const result = await hasSessionRelatedCronJobs({ sessionKey: "agent:main", agentId: "main" });
    expect(result).toBe(false);
  });

  it("returns false for an isolated job when agentId is not provided in params", async () => {
    loadCronStoreMock.mockResolvedValue(makeStore([{ enabled: true, agentId: "main" }]));

    const result = await hasSessionRelatedCronJobs({ sessionKey: "agent:main" });
    expect(result).toBe(false);
  });

  it("returns false for disabled jobs", async () => {
    loadCronStoreMock.mockResolvedValue(makeStore([{ enabled: false, sessionKey: "agent:main" }]));

    const result = await hasSessionRelatedCronJobs({ sessionKey: "agent:main" });
    expect(result).toBe(false);
  });

  it("returns false when cron store is empty", async () => {
    loadCronStoreMock.mockResolvedValue(makeStore([]));

    const result = await hasSessionRelatedCronJobs({ sessionKey: "agent:main" });
    expect(result).toBe(false);
  });

  it("returns false when cron store cannot be read", async () => {
    loadCronStoreMock.mockRejectedValue(new Error("ENOENT"));

    const result = await hasSessionRelatedCronJobs({ sessionKey: "agent:main" });
    expect(result).toBe(false);
  });
});
