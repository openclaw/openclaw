// Unit tests for purgeAgentCronJobs — verifies SQL generation and error resilience.
import { beforeEach, describe, expect, it, vi } from "vitest";

const stateDbMocks = vi.hoisted(() => ({
  db: {},
  openOpenClawStateDatabase: vi.fn(),
}));

// Build a mock Kysely query builder chain that records calls.
const mockDeleteChain = vi.hoisted(() => {
  const execSync = vi.fn();
  const deleteFrom = vi.fn(() => chain);
  const where = vi.fn(() => chain);
  const chain = { deleteFrom, where } as const;
  return { chain, execSync, deleteFrom, where };
});

vi.mock("../../state/openclaw-state-db.js", () => ({
  openOpenClawStateDatabase: stateDbMocks.openOpenClawStateDatabase,
}));

vi.mock("../../infra/kysely-sync.js", () => ({
  executeSqliteQuerySync: mockDeleteChain.execSync,
}));

// Return a mock Kysely facade that forwards to the spy chain.
vi.mock("./schema.js", () => ({
  getCronStoreKysely: () => ({
    deleteFrom: mockDeleteChain.deleteFrom,
  }),
}));

import { purgeAgentCronJobs } from "./purge-agent-cron-jobs.js";

describe("purgeAgentCronJobs", () => {
  beforeEach(() => {
    stateDbMocks.openOpenClawStateDatabase.mockReset();
    stateDbMocks.openOpenClawStateDatabase.mockReturnValue({ db: stateDbMocks.db });
    mockDeleteChain.execSync.mockReset();
    mockDeleteChain.deleteFrom.mockClear();
    mockDeleteChain.where.mockClear();
  });

  it("deletes rows where agent_id matches", () => {
    purgeAgentCronJobs("ops");

    expect(stateDbMocks.openOpenClawStateDatabase).toHaveBeenCalledOnce();
    expect(mockDeleteChain.deleteFrom).toHaveBeenCalledWith("cron_jobs");
    expect(mockDeleteChain.where).toHaveBeenCalledOnce();
    expect(mockDeleteChain.where).toHaveBeenCalledWith("agent_id", "=", "ops");
    expect(mockDeleteChain.execSync).toHaveBeenCalledOnce();
  });

  it("swallows errors when the state database is unavailable", () => {
    stateDbMocks.openOpenClawStateDatabase.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(() => purgeAgentCronJobs("ops")).not.toThrow();
    expect(mockDeleteChain.execSync).not.toHaveBeenCalled();
  });

  it("swallows errors when the delete query fails", () => {
    mockDeleteChain.execSync.mockImplementation(() => {
      throw new Error("SQLITE_BUSY");
    });

    expect(() => purgeAgentCronJobs("ops")).not.toThrow();
  });
});
