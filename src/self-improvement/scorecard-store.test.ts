import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listSelfImprovementDailyScorecards,
  writeSelfImprovementDailyScorecardSnapshot,
} from "./scorecard-store.js";
import type { SelfImprovementScorecard } from "./types.js";

let tmpDir: string;

function scorecard(generatedAt: number, activeRecommendations: number): SelfImprovementScorecard {
  return {
    generatedAt,
    totalRecommendations: activeRecommendations,
    activeRecommendations,
    groupedRecommendations: activeRecommendations,
    criticalOpen: 0,
    highOpen: activeRecommendations,
    testRequired: 0,
    approvalRequired: 0,
    reopenedLast24h: 0,
    resolvedLast24h: 0,
    byCategory: [],
    byRoute: [],
    needsApproval: [],
    whatImproved: [],
    whatWorsened: [],
  };
}

describe("self-improvement scorecard store", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-self-improvement-scorecards-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("upserts one scorecard snapshot per day", async () => {
    const first = Date.parse("2026-05-07T12:00:00.000Z");
    const later = Date.parse("2026-05-07T20:00:00.000Z");
    await writeSelfImprovementDailyScorecardSnapshot({
      stateDir: tmpDir,
      scorecard: scorecard(first, 1),
      now: first,
    });
    await writeSelfImprovementDailyScorecardSnapshot({
      stateDir: tmpDir,
      scorecard: scorecard(later, 3),
      now: later,
    });

    const scorecards = await listSelfImprovementDailyScorecards({ stateDir: tmpDir });
    expect(scorecards).toHaveLength(1);
    expect(scorecards[0]).toMatchObject({
      id: "sis_2026-05-07",
      dateKey: "2026-05-07",
      scorecard: { activeRecommendations: 3 },
    });
  });
});
