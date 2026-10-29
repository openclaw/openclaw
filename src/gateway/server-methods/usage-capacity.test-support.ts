import { DEFAULT_WORKER_PENDING_BYTES } from "@openclaw/worker-runtime";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadCombinedSessionStoreForGatewayCoreAsync } from "../../config/sessions/combined-store-gateway-read.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createEmptyCostUsageTotals } from "../../infra/session-cost-usage-totals.js";
import {
  discoverAllSessions,
  loadSessionCostSummariesFromCache,
} from "../../infra/session-cost-usage.js";
import { workerTaskPoolEntrypoints } from "../../infra/worker-task-pool-runtime.test-support.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type {
  PoolFixtureInput,
  PoolFixtureResult,
} from "../../infra/worker-task-pool.test-support.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";

function usageTotals(totalTokens: number, totalCost: number) {
  return { ...createEmptyCostUsageTotals(), totalTokens, totalCost };
}
function freshUsageBatch(summaries: ReturnType<typeof createEmptyCostUsageTotals>[]) {
  return {
    summaries,
    cacheStatus: {
      status: "fresh" as const,
      cachedFiles: summaries.length,
      pendingFiles: 0,
      staleFiles: 0,
    },
  };
}
export function registerUsageCapacityTest(params: {
  mockCombinedStore: (
    store: Record<string, SessionEntry>,
    owners: ReadonlyArray<readonly [string, string]>,
  ) => void;
  run: () => Promise<SessionsUsageResult>;
}): void {
  it("returns complete family usage while other reports occupy worker input capacity", async () => {
    const families = [
      { key: "agent:opus:capacity-first", prefix: "capacity-first", count: 2049 },
      { key: "agent:opus:capacity-second", prefix: "capacity-second", count: 2048 },
    ];
    const storePath =
      "/tmp/synthetic-usage-admission/retained-team-shaped-session-cost-usage-fixture/agents/opus/agent/openclaw-agent.sqlite";
    const rows = families.flatMap(({ prefix, count }) =>
      Array.from({ length: count }, (_, index) => {
        const sessionId = `${prefix}-${index}`;
        const sessionFile = `sqlite:opus:${sessionId}:${storePath}`;
        return {
          sessionId,
          sessionFile,
          mtime: 1000,
          transcriptFile: {
            kind: "sqlite" as const,
            filePath: sessionFile,
            sourcePath: sessionFile,
            sessionId,
            size: 1024,
            mtimeMs: 1000,
            eventCount: 4,
            maxSeq: 4,
            generation: "synthetic-generation",
            cold: false,
          },
        };
      }),
    );
    params.mockCombinedStore(
      Object.fromEntries(
        families.map(({ key, prefix, count }) => [
          key,
          {
            sessionId: `${prefix}-0`,
            updatedAt: 1000,
            usageFamilyKey: key,
            usageFamilySessionIds: Array.from(
              { length: count },
              (_, index) => `${prefix}-${index}`,
            ),
          },
        ]),
      ),
      families.map(({ key }) => [key, "opus"] as const),
    );
    // Charge the observed background queue without allocating its payload. Two
    // slots let a report finish while the background preparation remains admitted.
    const pool = new WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
      workerUrl: resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.worker),
      maxWorkers: 2,
      idleTimeoutMs: 0,
    });
    const release = createDeferred();
    const backgroundBytes = 265_155_910;
    const background = pool.run(
      async () => {
        await release.promise;
        return { label: "background usage reports" };
      },
      { inputBytes: backgroundBytes },
    );
    const backgroundOutcome = Promise.allSettled([background]);
    const originalDiscovery = vi.mocked(discoverAllSessions).getMockImplementation()!;
    const originalLoad = vi.mocked(loadSessionCostSummariesFromCache).getMockImplementation()!;
    try {
      // Fixture sanity: the full request is larger than the remaining real budget.
      // The admission charge below omits envelope fields, so it is conservative.
      expect(2 * JSON.stringify({ sessions: rows }).length).toBeGreaterThan(
        DEFAULT_WORKER_PENDING_BYTES - backgroundBytes,
      );
      vi.mocked(discoverAllSessions).mockResolvedValue(rows);
      vi.mocked(loadSessionCostSummariesFromCache).mockImplementation(async ({ sessions }) => {
        await pool.run(
          { label: "family usage report" },
          { inputBytes: 2 * JSON.stringify({ sessions }).length },
        );
        return freshUsageBatch(
          sessions.map(({ sessionId }) =>
            sessionId?.startsWith("capacity-first-")
              ? usageTotals(7, 0.125)
              : usageTotals(11, 0.25),
          ),
        );
      });
      const result = await params.run();
      expect(result.totals).toMatchObject({ totalTokens: 36_871, totalCost: 768.125 });
      expect(result.cacheStatus).toMatchObject({ status: "fresh", pendingFiles: 0, staleFiles: 0 });
      expect(result.partial).toBeUndefined();
      expect(result.sessions).toHaveLength(2);
      expect(result.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "agent:opus:capacity-first",
            usage: expect.objectContaining({ totalTokens: 14_343, totalCost: 256.125 }),
          }),
          expect.objectContaining({
            key: "agent:opus:capacity-second",
            usage: expect.objectContaining({ totalTokens: 22_528, totalCost: 512 }),
          }),
        ]),
      );
    } finally {
      vi.mocked(discoverAllSessions).mockImplementation(originalDiscovery);
      vi.mocked(loadSessionCostSummariesFromCache).mockImplementation(originalLoad);
      release.resolve();
      await backgroundOutcome;
      await pool.close();
    }
  });
}

export function mockCombinedStore(
  store: Record<string, SessionEntry>,
  owners: ReadonlyArray<readonly [string, string]>,
  storePath?: string,
) {
  vi.mocked(loadCombinedSessionStoreForGatewayCoreAsync).mockResolvedValue({
    durableTargets: [],
    storePath: "(multiple)",
    store,
    targetsBySessionKey: new Map(
      owners.map(([key, agentId]) => [
        key,
        {
          agentId,
          entry: store[key],
          readSourceEntry: (sourceKey: string) => store[sourceKey],
          resolveSourceKey: (sourceKey: string) => sourceKey,
          storeTarget: {
            agentId,
            storePath: storePath ?? `/tmp/agents/${agentId}/agent/openclaw-agent.sqlite`,
          },
        },
      ]),
    ),
  });
}
