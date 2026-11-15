import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  generateTeamShapeFixture,
  parseTeamShapeOptions,
} from "../../scripts/perf/team-shape-fixture.ts";
import { resetLogger } from "../../src/logging/logger.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock(import("../../scripts/perf/team-shape-sessions.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    seedTeamShapeSessions: async (...args: Parameters<typeof actual.seedTeamShapeSessions>) => {
      const seeded = await actual.seedTeamShapeSessions(...args);
      const { borrowOpenClawAgentDatabase } = await import("../../src/state/openclaw-agent-db.js");
      // Simulate active agent seeding while the shared-state connection is unused.
      const agent = borrowOpenClawAgentDatabase({ agentId: args[0].agentId ?? "main" });
      try {
        vi.advanceTimersByTime(31 * 60_000);
      } finally {
        agent.release();
      }
      return seeded;
    },
  };
});

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.useRealTimers();
  resetLogger();
});

it("finishes a fixture whose agent seeding outlasts shared-state idle retirement", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stateDir = path.join(temporary.make("team-shape-idle-"), "state");
  const options = parseTeamShapeOptions([
    "--state-dir",
    stateDir,
    "--sessions",
    "1",
    "--runs",
    "0",
    "--approvals",
    "0",
    "--cron",
    "0",
    "--projects",
    "0",
    "--transcript-mib",
    "0",
  ]);
  const { summary } = await generateTeamShapeFixture(options);
  expect(summary.sessionCount).toBe(1);
  expect(
    JSON.parse(fs.readFileSync(path.join(stateDir, "team-shape-summary.json"), "utf8")),
  ).toMatchObject({ sessionCount: 1, stateDatabaseBytes: summary.stateDatabaseBytes });
});
