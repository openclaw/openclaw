import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHeartbeatActiveHoursRuntime } from "./heartbeat-active-hours-runtime.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("migrated heartbeat ordinary scheduler evidence", () => {
  it("observes scheduled active fire, quiet-hours non-execution, and persisted reload fire", async () => {
    const artifactBase = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-active-hours-"));
    tempDirs.push(artifactBase);
    const evidence = await runHeartbeatActiveHoursRuntime({
      artifactBase,
      repoRoot: process.cwd(),
      timeoutMs: 5_000,
    });

    expect(evidence.entries[0]?.result.status).toBe("pass");
    const summary = JSON.parse(
      await fs.readFile(path.join(artifactBase, "heartbeat-active-hours-summary.json"), "utf8"),
    ) as { observations: Array<{ outcome: string; executions: number; nextRunAtMs: number }> };
    expect(summary.observations.map((entry) => entry.outcome)).toEqual([
      "active-fire",
      "quiet-hours-skip",
      "active-fire",
    ]);
    expect(summary.observations.map((entry) => entry.executions)).toEqual([1, 1, 2]);
    const nextRuns = summary.observations.map((entry) => entry.nextRunAtMs);
    expect(nextRuns[1]).toBeGreaterThan(nextRuns[0]!);
    expect(nextRuns[2]).toBeGreaterThan(nextRuns[1]!);
  });
});
