import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { isSessionCostUsageRefreshRunning } from "./session-cost-usage-cache.sqlite.js";
import { loadSessionCostSummary } from "./session-cost-usage-reporting.js";
import { runUsageCostWorker } from "./session-cost-usage-worker-runtime.js";
import type { UsageCostWorkerResult } from "./session-cost-usage-worker.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("./session-cost-usage-aggregation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-cost-usage-aggregation.js")>();
  return {
    ...actual,
    refreshCostUsageCacheForAgent: vi.fn(async () => "busy" as const),
  };
});

vi.mock("./session-cost-usage-cache.sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-cost-usage-cache.sqlite.js")>();
  return {
    ...actual,
    isSessionCostUsageRefreshRunning: vi.fn(async () => true),
  };
});

vi.mock("./session-cost-usage-worker-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-cost-usage-worker-runtime.js")>();
  return {
    ...actual,
    runUsageCostWorker: vi.fn(actual.runUsageCostWorker),
  };
});

describe("loadSessionCostSummary direct refresh wait", () => {
  it("stops polling a busy refresh lock after the wait budget", async () => {
    const root = tempDirs.make("openclaw-usage-busy-");
    const sessionFile = path.join(root, "transcript.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "hi", timestamp: Date.now() } })}\n`,
    );

    const startedAt = Date.now();
    let waitPhase: "start" | "expired" = "start";
    const now = vi
      .spyOn(Date, "now")
      .mockImplementation(() => (waitPhase === "start" ? startedAt : startedAt + 5_000));
    vi.mocked(isSessionCostUsageRefreshRunning).mockImplementation(async () => {
      waitPhase = "expired";
      return true;
    });

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        await expect(
          loadSessionCostSummary({
            agentId: "main",
            sessionFile,
          }).then((summary) => summary ?? "empty"),
        ).resolves.toBe("empty");
      });
    } finally {
      now.mockRestore();
    }
  });

  it("drops a stale checkpoint when the refresh lock stays busy", async () => {
    const root = tempDirs.make("openclaw-usage-stale-");
    const sessionFile = path.join(root, "transcript.jsonl");
    await fs.writeFile(sessionFile, "{}\n");
    const startedAt = Date.now();
    let phase: "start" | "expired" = "start";
    const now = vi
      .spyOn(Date, "now")
      .mockImplementation(() => (phase === "start" ? startedAt : startedAt + 5_000));
    vi.mocked(isSessionCostUsageRefreshRunning).mockImplementation(async () => {
      phase = "expired";
      return true;
    });
    const stale: UsageCostWorkerResult = {
      kind: "sessions",
      summaries: [
        {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          totalCost: 0,
          inputCost: 0,
          outputCost: 0,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          missingCostEntries: 0,
          staleSince: startedAt,
          sessionFile,
        },
      ],
      cacheStatus: { status: "partial", cachedFiles: 1, pendingFiles: 1, staleFiles: 1 },
      staleSessionFiles: [sessionFile],
      invalidRows: [],
    };
    vi.mocked(runUsageCostWorker)
      .mockImplementationOnce(async () => ({
        kind: "inventory",
        files: [{ kind: "jsonl", sourcePath: sessionFile, sessionId: "s", mtimeMs: startedAt }],
      }))
      .mockImplementationOnce(async () => stale);
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        await expect(loadSessionCostSummary({ agentId: "main", sessionFile })).resolves.toBeNull();
      });
    } finally {
      now.mockRestore();
    }
  });
});
