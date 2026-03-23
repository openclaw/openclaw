import { beforeEach, describe, expect, it, vi } from "vitest";
import { AggregateComputer } from "./aggregates.js";
import { ActionLedger } from "./ledger.js";
import { CandidateRanker, type RankingWeights } from "./ranker.js";
import type {
  ActionRecord,
  AggregateStats,
  CandidateAction,
  PolicyContext,
  PolicyFeedbackConfig,
  RankCandidatesInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<PolicyFeedbackConfig>): PolicyFeedbackConfig {
  return {
    mode: "active",
    aggregateIntervalMs: 3_600_000,
    outcomeHorizons: [60_000],
    constraints: [],
    logRetentionDays: 90,
    perAgentScoping: true,
    ...overrides,
  };
}

function makeCandidate(overrides?: Partial<CandidateAction>): CandidateAction {
  return {
    id: "cand-1",
    actionType: "agent_reply",
    description: "Reply to user",
    ...overrides,
  };
}

function makeContext(overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    channelId: "telegram",
    hourOfDay: 14,
    recentActionCount: 0,
    consecutiveIgnores: 0,
    ...overrides,
  };
}

function emptyStats(): AggregateStats {
  return {
    computedAt: new Date().toISOString(),
    totalActions: 0,
    totalOutcomes: 0,
    byActionType: {},
    byHourOfDay: {},
    byConsecutiveIgnores: {},
    byChannel: {},
  };
}

function makeStats(overrides?: Partial<AggregateStats>): AggregateStats {
  return { ...emptyStats(), ...overrides };
}

function makeRecentAction(
  actionType: string,
  hoursAgo: number,
): Pick<ActionRecord, "timestamp" | "actionType"> {
  const ts = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  return { timestamp: ts, actionType: actionType as ActionRecord["actionType"] };
}

function makeInput(candidates?: CandidateAction[], context?: PolicyContext): RankCandidatesInput {
  return {
    agentId: "agent-1",
    sessionKey: "session-abc",
    candidates: candidates ?? [makeCandidate()],
    context: context ?? makeContext(),
  };
}

/** Create a ranker with mocked dependencies */
function createRanker(opts?: {
  config?: Partial<PolicyFeedbackConfig>;
  stats?: AggregateStats;
  recentActions?: Pick<ActionRecord, "timestamp" | "actionType">[];
  weights?: Partial<RankingWeights>;
}) {
  const config = makeConfig(opts?.config);

  const aggregates = new AggregateComputer();
  vi.spyOn(aggregates, "getAggregates").mockResolvedValue([opts?.stats ?? emptyStats()]);

  const ledger = new ActionLedger("/tmp/test-policy", config);
  vi.spyOn(ledger, "getRecentActions").mockResolvedValue(
    (opts?.recentActions ?? []) as ActionRecord[],
  );

  const ranker = new CandidateRanker(aggregates, config, ledger, opts?.weights);
  return { ranker, aggregates, ledger };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CandidateRanker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. Base score with no history
  // -----------------------------------------------------------------------
  it("assigns base score of 0.5 when no historical data exists", async () => {
    const { ranker } = createRanker();
    const results = await ranker.rankCandidates(makeInput());

    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0.5);
    expect(results[0].suppress).toBe(false);
    expect(results[0].reasons).toContain("Base score: 50");
  });

  // -----------------------------------------------------------------------
  // 2. Historical effectiveness bonus
  // -----------------------------------------------------------------------
  it("applies positive historical effectiveness bonus for high reply rate", async () => {
    const stats = makeStats({
      totalActions: 100,
      byActionType: {
        agent_reply: {
          count: 100,
          outcomeCount: 80,
          replyRate: 0.8, // above 0.5 => positive adjustment
          suppressionRate: 0,
        },
      },
    });

    const { ranker } = createRanker({ stats });
    const results = await ranker.rankCandidates(makeInput());

    // 0.8 - 0.5 = 0.3; 0.3 * 2 * 20 = 12 points bonus => (50+12)/100 = 0.62
    expect(results[0].score).toBeCloseTo(0.62, 2);
    expect(results[0].reasons.some((r) => r.includes("Historical effectiveness"))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 3. Historical effectiveness penalty
  // -----------------------------------------------------------------------
  it("applies negative historical effectiveness for low reply rate", async () => {
    const stats = makeStats({
      totalActions: 100,
      byActionType: {
        agent_reply: {
          count: 100,
          outcomeCount: 20,
          replyRate: 0.2, // below 0.5 => negative adjustment
          suppressionRate: 0,
        },
      },
    });

    const { ranker } = createRanker({ stats });
    const results = await ranker.rankCandidates(makeInput());

    // 0.2 - 0.5 = -0.3; -0.3 * 2 * 20 = -12 => (50-12)/100 = 0.38
    expect(results[0].score).toBeCloseTo(0.38, 2);
  });

  // -----------------------------------------------------------------------
  // 4. Intervention fatigue penalty
  // -----------------------------------------------------------------------
  it("applies fatigue penalty based on recentActionCount", async () => {
    const { ranker } = createRanker();
    const context = makeContext({ recentActionCount: 3 });
    const results = await ranker.rankCandidates(makeInput([makeCandidate()], context));

    // 3 actions * 5 penalty = -15 => (50-15)/100 = 0.35
    expect(results[0].score).toBeCloseTo(0.35, 2);
  });

  // -----------------------------------------------------------------------
  // 5. Fatigue penalty capped at max
  // -----------------------------------------------------------------------
  it("caps fatigue penalty at maxFatiguePenalty", async () => {
    const { ranker } = createRanker();
    const context = makeContext({ recentActionCount: 10 }); // 10*5=50, capped at 25
    const results = await ranker.rankCandidates(makeInput([makeCandidate()], context));

    // Capped at 25 => (50-25)/100 = 0.25
    expect(results[0].score).toBeCloseTo(0.25, 2);
  });

  // -----------------------------------------------------------------------
  // 6. Time-of-day bonus
  // -----------------------------------------------------------------------
  it("applies time-of-day bonus for high-performing hours", async () => {
    const stats = makeStats({
      totalActions: 100,
      byHourOfDay: {
        14: { count: 50, replyRate: 0.9 },
        2: { count: 50, replyRate: 0.3 },
      },
    });

    const { ranker } = createRanker({ stats });
    const context = makeContext({ hourOfDay: 14 });
    const results = await ranker.rankCandidates(makeInput([makeCandidate()], context));

    // Average replyRate = (0.9+0.3)/2 = 0.6; deviation = 0.9-0.6 = 0.3
    // clamped = min(1, 0.3*2) = 0.6; adjustment = 0.6 * 10 = 6
    // Score = (50+6)/100 = 0.56
    expect(results[0].score).toBeCloseTo(0.56, 2);
    expect(results[0].reasons.some((r) => r.includes("Time-of-day"))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 7. Time-of-day penalty
  // -----------------------------------------------------------------------
  it("applies time-of-day penalty for low-performing hours", async () => {
    const stats = makeStats({
      totalActions: 100,
      byHourOfDay: {
        14: { count: 50, replyRate: 0.9 },
        2: { count: 50, replyRate: 0.3 },
      },
    });

    const { ranker } = createRanker({ stats });
    const context = makeContext({ hourOfDay: 2 });
    const results = await ranker.rankCandidates(makeInput([makeCandidate()], context));

    // Average = 0.6; deviation = 0.3-0.6 = -0.3; clamped = -0.6; adj = -6
    // Score = (50-6)/100 = 0.44
    expect(results[0].score).toBeCloseTo(0.44, 2);
  });

  // -----------------------------------------------------------------------
  // 8. Recency penalty
  // -----------------------------------------------------------------------
  it("applies recency penalty for same action type in 24h", async () => {
    const recentActions = [
      makeRecentAction("agent_reply", 2),
      makeRecentAction("agent_reply", 5),
      makeRecentAction("agent_reply", 12),
      makeRecentAction("tool_call", 1), // different type, not counted
    ];

    const { ranker } = createRanker({ recentActions });
    const results = await ranker.rankCandidates(makeInput());

    // 3 same-type actions * 3 penalty = 9 => (50-9)/100 = 0.41
    expect(results[0].score).toBeCloseTo(0.41, 2);
  });

  // -----------------------------------------------------------------------
  // 9. Recency penalty capped at max
  // -----------------------------------------------------------------------
  it("caps recency penalty at maxRecencyPenalty", async () => {
    const recentActions = Array.from({ length: 10 }, (_, i) =>
      makeRecentAction("agent_reply", i + 1),
    );

    const { ranker } = createRanker({ recentActions });
    const results = await ranker.rankCandidates(makeInput());

    // 10 * 3 = 30, capped at 15 => (50-15)/100 = 0.35
    expect(results[0].score).toBeCloseTo(0.35, 2);
  });

  // -----------------------------------------------------------------------
  // 10. Risk adjustment penalty
  // -----------------------------------------------------------------------
  it("applies risk penalty when reply rate low and data scarce", async () => {
    const stats = makeStats({
      totalActions: 20, // low data => confidence = 20/100 = 0.2 < 0.5
      byActionType: {
        agent_reply: {
          count: 20,
          outcomeCount: 5,
          replyRate: 0.15, // low reply rate
          suppressionRate: 0,
        },
      },
    });

    const { ranker } = createRanker({ stats });
    const results = await ranker.rankCandidates(makeInput());

    // Historical: (0.15-0.5)*2*20 = -14
    // Risk: -10
    // Score = (50-14-10)/100 = 0.26
    expect(results[0].score).toBeCloseTo(0.26, 2);
    expect(results[0].reasons.some((r) => r.includes("Risk adjustment"))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 11. No risk penalty when enough data
  // -----------------------------------------------------------------------
  it("does not apply risk penalty when confidence is high", async () => {
    const stats = makeStats({
      totalActions: 200, // high data => confidence > 0.5
      byActionType: {
        agent_reply: {
          count: 200,
          outcomeCount: 30,
          replyRate: 0.15,
          suppressionRate: 0,
        },
      },
    });

    const { ranker } = createRanker({ stats });
    const results = await ranker.rankCandidates(makeInput());

    // Historical: (0.15-0.5)*2*20 = -14
    // No risk penalty because confidence > 0.5
    // Score = (50-14)/100 = 0.36
    expect(results[0].score).toBeCloseTo(0.36, 2);
    expect(results[0].reasons.every((r) => !r.includes("Risk adjustment"))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 12. Suppression threshold
  // -----------------------------------------------------------------------
  it("suppresses candidates below suppressionThreshold", async () => {
    const { ranker } = createRanker();
    // 5 actions * 5 = 25 fatigue penalty => score = 25/100 = 0.25 < 0.30 threshold
    const context = makeContext({ recentActionCount: 5 });
    const results = await ranker.rankCandidates(makeInput([makeCandidate()], context));

    expect(results[0].suppress).toBe(true);
    expect(results[0].suppressionRule).toBe("score_below_threshold");
  });

  // -----------------------------------------------------------------------
  // 13. Custom suppression threshold
  // -----------------------------------------------------------------------
  it("respects custom suppressionThreshold", async () => {
    const { ranker } = createRanker({
      weights: { suppressionThreshold: 60 },
    });
    const results = await ranker.rankCandidates(makeInput());

    // Score = 50/100 = 0.5, but internal score 50 < threshold 60 => suppressed
    expect(results[0].suppress).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 14. Composite scoring with custom weights
  // -----------------------------------------------------------------------
  it("applies custom weights correctly", async () => {
    const stats = makeStats({
      totalActions: 100,
      byActionType: {
        agent_reply: {
          count: 100,
          outcomeCount: 80,
          replyRate: 0.8,
          suppressionRate: 0,
        },
      },
    });

    const { ranker } = createRanker({
      stats,
      weights: {
        historicalEffectiveness: 40, // double the default
      },
    });
    const results = await ranker.rankCandidates(makeInput());

    // (0.8-0.5)*2*40 = 24 => (50+24)/100 = 0.74
    expect(results[0].score).toBeCloseTo(0.74, 2);
  });

  // -----------------------------------------------------------------------
  // 15. Feature flag disabled
  // -----------------------------------------------------------------------
  it("returns unsorted candidates with 0.5 score when ranking disabled", async () => {
    const { ranker } = createRanker({
      config: { mode: "off" },
    });

    const candidates = [makeCandidate({ id: "a" }), makeCandidate({ id: "b" })];
    const results = await ranker.rankCandidates(makeInput(candidates));

    expect(results).toHaveLength(2);
    expect(results[0].score).toBe(0.5);
    expect(results[1].score).toBe(0.5);
    expect(results[0].suppress).toBe(false);
    // Order preserved (not sorted)
    expect(results[0].candidate.id).toBe("a");
    expect(results[1].candidate.id).toBe("b");
  });

  // -----------------------------------------------------------------------
  // 16. Advisory mode note
  // -----------------------------------------------------------------------
  it("adds advisory mode note in advisory mode", async () => {
    const { ranker } = createRanker({
      config: { mode: "advisory" },
    });
    const results = await ranker.rankCandidates(makeInput());

    expect(results[0].reasons).toContain("mode: advisory");
  });

  // -----------------------------------------------------------------------
  // 17. Empty candidates
  // -----------------------------------------------------------------------
  it("returns empty array for empty candidates", async () => {
    const { ranker } = createRanker();
    const results = await ranker.rankCandidates(makeInput([]));

    expect(results).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // 18. Sorting: highest score first
  // -----------------------------------------------------------------------
  it("sorts candidates by score descending", async () => {
    const stats = makeStats({
      totalActions: 100,
      byActionType: {
        agent_reply: {
          count: 50,
          outcomeCount: 40,
          replyRate: 0.9,
          suppressionRate: 0,
        },
        tool_call: {
          count: 50,
          outcomeCount: 10,
          replyRate: 0.1,
          suppressionRate: 0,
        },
      },
    });

    const candidates = [
      makeCandidate({ id: "low", actionType: "tool_call" }),
      makeCandidate({ id: "high", actionType: "agent_reply" }),
    ];

    const { ranker } = createRanker({ stats });
    const results = await ranker.rankCandidates(makeInput(candidates));

    expect(results[0].candidate.id).toBe("high");
    expect(results[1].candidate.id).toBe("low");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  // -----------------------------------------------------------------------
  // 19. Multiple factors combine
  // -----------------------------------------------------------------------
  it("combines multiple scoring factors correctly", async () => {
    const stats = makeStats({
      totalActions: 100,
      byActionType: {
        agent_reply: {
          count: 100,
          outcomeCount: 80,
          replyRate: 0.8,
          suppressionRate: 0,
        },
      },
      byHourOfDay: {
        14: { count: 50, replyRate: 0.8 },
        3: { count: 50, replyRate: 0.4 },
      },
    });

    const recentActions = [makeRecentAction("agent_reply", 1), makeRecentAction("agent_reply", 3)];

    const { ranker } = createRanker({ stats, recentActions });
    const context = makeContext({ hourOfDay: 14, recentActionCount: 2 });
    const results = await ranker.rankCandidates(makeInput([makeCandidate()], context));

    // Base: 50
    // Historical: (0.8-0.5)*2*20 = 12
    // Fatigue: -2*5 = -10
    // Time-of-day: avg=(0.8+0.4)/2=0.6, dev=0.8-0.6=0.2, clamped=0.4, adj=4
    // Recency: 2 same-type * 3 = -6
    // Score = (50+12-10+4-6)/100 = 50/100 = 0.5
    expect(results[0].score).toBeCloseTo(0.5, 2);
    expect(results[0].reasons.length).toBeGreaterThanOrEqual(4);
  });

  // -----------------------------------------------------------------------
  // 20. Score clamped to [0, 1]
  // -----------------------------------------------------------------------
  it("clamps score to [0, 1] range", async () => {
    // Extreme fatigue + recency + low effectiveness to push below 0
    const stats = makeStats({
      totalActions: 10,
      byActionType: {
        agent_reply: {
          count: 10,
          outcomeCount: 1,
          replyRate: 0.0,
          suppressionRate: 0,
        },
      },
    });

    const recentActions = Array.from({ length: 20 }, (_, i) =>
      makeRecentAction("agent_reply", i * 0.5),
    );

    const { ranker } = createRanker({ stats, recentActions });
    const context = makeContext({ recentActionCount: 10 });
    const results = await ranker.rankCandidates(makeInput([makeCandidate()], context));

    expect(results[0].score).toBeGreaterThanOrEqual(0);
    expect(results[0].score).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// getPolicyHints
// ---------------------------------------------------------------------------

describe("CandidateRanker.getPolicyHints", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns proceed recommendation when score is above threshold", async () => {
    const { ranker } = createRanker();
    const hints = await ranker.getPolicyHints({
      agentId: "agent-1",
      sessionKey: "session-abc",
      channelId: "telegram",
      context: makeContext(),
    });

    expect(hints.recommendation).toBe("proceed");
    expect(hints.mode).toBe("active");
    expect(hints.fatigueLevel).toBe(0);
  });

  it("returns suppress recommendation when candidate is suppressed", async () => {
    const { ranker } = createRanker();
    const hints = await ranker.getPolicyHints({
      agentId: "agent-1",
      sessionKey: "session-abc",
      channelId: "telegram",
      context: makeContext({ recentActionCount: 10 }),
    });

    // Score will be low due to fatigue => suppression
    expect(hints.recommendation).toBe("suppress");
    expect(hints.activeConstraints.length).toBeGreaterThan(0);
  });

  it("returns caution when score is moderate but not suppressed", async () => {
    // Create a scenario where score is below 0.5 but above suppression threshold
    const stats = makeStats({
      totalActions: 100,
      byActionType: {
        agent_reply: {
          count: 100,
          outcomeCount: 20,
          replyRate: 0.2,
          suppressionRate: 0,
        },
      },
    });

    const { ranker } = createRanker({ stats });
    const hints = await ranker.getPolicyHints({
      agentId: "agent-1",
      sessionKey: "session-abc",
      channelId: "telegram",
      context: makeContext(),
    });

    // Score: 50 + (0.2-0.5)*2*20 = 50-12 = 38 => 0.38, above 30 threshold
    expect(hints.recommendation).toBe("caution");
  });

  it("computes fatigue level from context", async () => {
    const { ranker } = createRanker();
    const hints = await ranker.getPolicyHints({
      agentId: "agent-1",
      sessionKey: "session-abc",
      channelId: "telegram",
      context: makeContext({ recentActionCount: 7 }),
    });

    expect(hints.fatigueLevel).toBeCloseTo(0.7, 2);
  });

  it("includes timing hint when hour data is available", async () => {
    const stats = makeStats({
      totalActions: 100,
      byHourOfDay: {
        14: { count: 50, replyRate: 0.1 },
      },
    });

    const { ranker } = createRanker({ stats });
    const hints = await ranker.getPolicyHints({
      agentId: "agent-1",
      sessionKey: "session-abc",
      channelId: "telegram",
      context: makeContext({ hourOfDay: 14 }),
    });

    expect(hints.timingHint).toBeDefined();
  });
});
