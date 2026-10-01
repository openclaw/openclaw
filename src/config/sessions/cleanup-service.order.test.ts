import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const calls = vi.hoisted(() => [] as string[]);
const sweepTombstones = vi.hoisted(() =>
  vi.fn(async ({ dryRun }: { dryRun: boolean }) => {
    calls.push(`tombstones:${dryRun ? "preview" : "apply"}`);
    return {
      candidates: 1,
      removedNodes: dryRun ? 0 : 1,
      sweptTranscriptStates: dryRun ? 0 : 1,
      olderThanMs: 60 * 60 * 1000,
    };
  }),
);

vi.mock("./cleanup-tombstones.js", () => ({
  sweepTombstonedCronRunRemnantsForStore: sweepTombstones,
}));

vi.mock("./session-history-eviction.js", () => ({
  inspectSqliteSessionHistoryDiskBudget: vi.fn(async () => {
    calls.push("budget:preview");
    return { diskBudget: null, wouldMutate: false };
  }),
  enforceSqliteSessionHistoryDiskBudget: vi.fn(async () => {
    calls.push("budget:apply");
    return null;
  }),
}));

import { runSessionsCleanup } from "./cleanup-service.js";

describe("sessions cleanup ordering", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    calls.length = 0;
    sweepTombstones.mockClear();
    // Drain the agent database owners before the temp-dir tracker (registered
    // earlier, so it runs later) removes the state directory under them.
    if (tempDir) {
      await cleanupSessionStateForTest({ stateDir: tempDir });
      tempDir = undefined;
    }
  });

  it("sweeps retained cron placeholders before disk-budget enforcement", async () => {
    tempDir = tempDirs.make("openclaw-cleanup-order-");
    const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    try {
      const result = await runSessionsCleanup({
        cfg: { cron: { sessionRetention: "1h" } },
        opts: { enforce: true },
        targets: [{ agentId: "main", storePath }],
      });
      expect(result.appliedSummaries[0]?.wouldMutate).toBe(true);
    } finally {
      delete process.env.OPENCLAW_STATE_DIR;
    }

    expect(calls.indexOf("tombstones:apply")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("tombstones:apply")).toBeLessThan(calls.indexOf("budget:apply"));
    expect(sweepTombstones).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { agentId: "main", storePath },
        retentionMs: 60 * 60 * 1000,
        dryRun: false,
      }),
    );
  });
});
