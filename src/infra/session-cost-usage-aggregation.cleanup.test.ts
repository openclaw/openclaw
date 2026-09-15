import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";

const mocks = vi.hoisted(() => ({
  acquire:
    vi.fn<
      typeof import("./session-cost-usage-cache.sqlite.js").acquireSessionCostUsageRefreshLock
    >(),
  readRows:
    vi.fn<typeof import("./session-cost-usage-cache.sqlite.js").readSessionCostUsageRollupRows>(),
  release: vi.fn<() => Promise<void>>(),
  listFiles:
    vi.fn<typeof import("./session-cost-usage-collection.js").listUsageCountedTranscriptStats>(),
  prune:
    vi.fn<
      typeof import("./session-cost-usage-cache.sqlite.js").deleteSessionCostUsageRollupsExcept
    >(),
}));

vi.mock("./session-cost-usage-cache.sqlite.js", () => ({
  acquireSessionCostUsageRefreshLock: mocks.acquire,
  readSessionCostUsageRollupRows: mocks.readRows,
  deleteSessionCostUsageRollupsExcept: mocks.prune,
  writeSessionCostUsageRollup: vi.fn(),
}));
vi.mock("./session-cost-usage-collection.js", () => ({
  listUsageCountedTranscriptStats: mocks.listFiles,
  resolveUsageCostTranscriptFile: vi.fn(),
}));
vi.mock("../state/openclaw-agent-db.js", () => ({
  resolveOpenClawAgentSqlitePath: () => "/synthetic/usage.sqlite",
}));
vi.mock("../agents/agent-scope-config.js", () => ({
  resolveAgentDir: () => "/synthetic/agent",
}));
vi.mock("../model-catalog/pricing.js", () => ({
  prepareModelPricingContext: async () => undefined,
}));
vi.mock("../utils/usage-format.js", () => ({
  resolveModelCostConfigFingerprint: () => "synthetic-pricing",
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  loadTranscriptEventRowsAfterSeqSync: vi.fn(),
  readTranscriptEventAtSeqSync: vi.fn(),
}));
vi.mock("./session-cost-usage-pricing.js", () => ({
  createUsageCostResolver: () => () => undefined,
  applyCostBreakdown: vi.fn(),
  applyCostTotal: vi.fn(),
  applyUsageTotals: vi.fn(),
  parseUsageCostTranscriptEntry: vi.fn(),
}));

const refresh = () =>
  refreshCostUsageCacheForAgent({
    agentId: "usage-test",
    agentDir: "/synthetic/agent",
    databasePath: "/synthetic/usage.sqlite",
  });

async function rejectedRefresh(): Promise<unknown> {
  const [outcome] = await Promise.allSettled([refresh()]);
  if (outcome.status !== "rejected") {
    throw new Error("Refresh unexpectedly succeeded");
  }
  return outcome.reason;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.release.mockResolvedValue(undefined);
  mocks.acquire.mockResolvedValue({ acquired: true, release: mocks.release });
  mocks.readRows.mockReturnValue([]);
  mocks.listFiles.mockResolvedValue([]);
  mocks.prune.mockResolvedValue(undefined);
});

describe("usage refresh lock cleanup", () => {
  it.each([
    { phase: "refresh", failure: new Error("refresh failed") },
    { phase: "release", failure: new Error("release failed") },
    { phase: "refresh", failure: undefined },
    { phase: "release", failure: undefined },
  ] as const)("preserves the sole $phase rejection ($failure)", async ({ phase, failure }) => {
    (phase === "refresh" ? mocks.listFiles : mocks.release).mockRejectedValueOnce(failure);

    expect(await rejectedRefresh()).toBe(failure);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "ordinary errors",
      primary: new Error("refresh failed"),
      cleanup: new Error("release failed"),
    },
    {
      name: "worker outcome",
      primary: new SqliteWorkerError("read failed", "outcome-unknown"),
      cleanup: new Error("release failed"),
    },
    {
      name: "undefined refresh rejection",
      primary: undefined,
      cleanup: new Error("release failed"),
    },
    {
      name: "undefined release rejection",
      primary: new Error("refresh failed"),
      cleanup: undefined,
    },
  ])("retains both failures and the primary cause for $name", async ({ primary, cleanup }) => {
    mocks.listFiles.mockRejectedValueOnce(primary);
    mocks.release.mockRejectedValueOnce(cleanup);

    const failure = await rejectedRefresh();
    if (!(failure instanceof AggregateError)) {
      throw new Error("Both refresh and release failures must reach the caller", {
        cause: failure,
      });
    }
    expect(failure.errors).toHaveLength(2);
    for (const [index, original] of [primary, cleanup].entries()) {
      if (original instanceof Error) {
        expect(failure.errors[index]).toBe(original);
      } else {
        expect(failure.errors[index]).toBeInstanceOf(Error);
        expect(failure.errors[index]).toHaveProperty("cause", original);
      }
    }
    expect(failure.cause).toBe(failure.errors[0]);
    if (primary instanceof SqliteWorkerError) {
      expect(failure).toMatchObject({ code: primary.code });
    }
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it.each([true, false])("releases only an acquired lock (acquired=%s)", async (acquired) => {
    mocks.acquire.mockResolvedValueOnce({ acquired, release: mocks.release });

    await expect(refresh()).resolves.toBe(acquired ? "refreshed" : "busy");
    expect(mocks.release).toHaveBeenCalledTimes(acquired ? 1 : 0);
    expect(mocks.readRows).toHaveBeenCalledTimes(acquired ? 1 : 0);
  });
});
