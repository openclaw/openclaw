import { describe, expect, it } from "vitest";
import { scoreEvent } from "./salience-scorer.js";
import type { AttentionConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal stub config
// ---------------------------------------------------------------------------

const CONFIG: AttentionConfig = {
  version: "1.0",
  last_calibrated: "2026-03-02",
  calibration_notes: "test stub",
  base_weights: {
    urgency: 0.22,
    strategic_importance: 0.22,
    personal_relevance: 0.14,
    time_sensitivity: 0.18,
    reversibility_cost: 0.14,
    novelty: 0.1,
  },
  modes: {
    deep_work: {
      description: "Focused building",
      weight_modifiers: {
        urgency: 0.8,
        strategic_importance: 1.2,
        personal_relevance: 0.6,
        time_sensitivity: 0.7,
        reversibility_cost: 1.0,
        novelty: 0.5,
      },
      suppression_threshold: 0.65,
      hysteresis: { entry_threshold: 0.7, exit_threshold: 0.45, min_dwell_minutes: 30 },
      channels_amplified: ["build-log"],
      channels_suppressed: ["research-radar"],
    },
    trading: {
      description: "Market hours",
      weight_modifiers: {
        urgency: 1.3,
        strategic_importance: 1.0,
        personal_relevance: 0.5,
        time_sensitivity: 1.4,
        reversibility_cost: 1.3,
        novelty: 1.2,
      },
      suppression_threshold: 0.5,
      hysteresis: { entry_threshold: 0.6, exit_threshold: 0.35, min_dwell_minutes: 45 },
      channels_amplified: ["trading-signals"],
      channels_suppressed: ["osce-practice"],
    },
    admin: {
      description: "Admin",
      weight_modifiers: {
        urgency: 1.0,
        strategic_importance: 0.8,
        personal_relevance: 1.0,
        time_sensitivity: 1.0,
        reversibility_cost: 0.8,
        novelty: 0.6,
      },
      suppression_threshold: 0.4,
      hysteresis: { entry_threshold: 0.45, exit_threshold: 0.25, min_dwell_minutes: 20 },
      channels_amplified: ["general"],
      channels_suppressed: [],
    },
    social: {
      description: "Social",
      weight_modifiers: {
        urgency: 0.5,
        strategic_importance: 0.3,
        personal_relevance: 1.0,
        time_sensitivity: 0.4,
        reversibility_cost: 0.8,
        novelty: 0.3,
      },
      suppression_threshold: 0.8,
      hysteresis: { entry_threshold: 0.85, exit_threshold: 0.6, min_dwell_minutes: 60 },
      channels_amplified: [],
      channels_suppressed: ["all"],
    },
  },
  time_defaults: { "09:00-17:00": "deep_work" },
  explicit_command_keywords: {},
  calendar_keyword_map: {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scoreEvent — basic", () => {
  it("returns a score in [0, 1]", () => {
    const score = scoreEvent("Hello world", "general", "admin", [], CONFIG);
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(1);
  });

  it("returns all 6 factors", () => {
    const score = scoreEvent("test", "general", "admin", [], CONFIG);
    const keys = Object.keys(score.factors);
    expect(keys).toContain("urgency");
    expect(keys).toContain("strategic_importance");
    expect(keys).toContain("personal_relevance");
    expect(keys).toContain("time_sensitivity");
    expect(keys).toContain("reversibility_cost");
    expect(keys).toContain("novelty");
  });

  it("mode_applied reflects current mode", () => {
    const score = scoreEvent("test", "general", "trading", [], CONFIG);
    expect(score.mode_applied).toBe("trading");
  });

  it("falls back to uncertain for unknown mode", () => {
    const score = scoreEvent("test", "general", "unknown_mode_xyz", [], CONFIG);
    expect(score.mode_applied).toBe("uncertain");
  });
});

describe("scoreEvent — urgency heuristic", () => {
  it("scores higher for urgent keywords", () => {
    const low = scoreEvent("A cool paper to read sometime", "general", "admin", [], CONFIG);
    const high = scoreEvent(
      "URGENT deadline today emergency alert stop-loss",
      "general",
      "admin",
      [],
      CONFIG,
    );
    expect(high.factors.urgency).toBeGreaterThan(low.factors.urgency);
  });

  it("scores 0.9 for multiple urgency keywords", () => {
    const score = scoreEvent("urgent deadline emergency critical", "general", "admin", [], CONFIG);
    expect(score.factors.urgency).toBe(0.9);
  });

  it("scores 0.1 for no urgency keywords", () => {
    const score = scoreEvent(
      "here is some general information about nothing",
      "general",
      "admin",
      [],
      CONFIG,
    );
    expect(score.factors.urgency).toBe(0.1);
  });
});

describe("scoreEvent — strategic_importance by channel", () => {
  it("scores trading-signals higher than general", () => {
    const trading = scoreEvent("some content", "trading-signals", "admin", [], CONFIG);
    const general = scoreEvent("some content", "general", "admin", [], CONFIG);
    expect(trading.factors.strategic_importance).toBeGreaterThan(
      general.factors.strategic_importance,
    );
  });

  it("scores unknown channel at default low importance", () => {
    const score = scoreEvent("content", "unknown-channel-xyz", "admin", [], CONFIG);
    expect(score.factors.strategic_importance).toBeLessThan(0.4);
  });
});

describe("scoreEvent — personal_relevance heuristic", () => {
  it("scores high when 'Nir' is mentioned", () => {
    const score = scoreEvent("Hey Nir, check this out", "general", "admin", [], CONFIG);
    expect(score.factors.personal_relevance).toBe(0.8);
  });

  it("scores high when direct pronouns are used", () => {
    const score = scoreEvent(
      "this is your position expiring today",
      "general",
      "admin",
      [],
      CONFIG,
    );
    expect(score.factors.personal_relevance).toBe(0.8);
  });

  it("scores low for impersonal content", () => {
    const score = scoreEvent(
      "the market opened at 9:30 AM eastern time",
      "general",
      "admin",
      [],
      CONFIG,
    );
    expect(score.factors.personal_relevance).toBe(0.3);
  });
});

describe("scoreEvent — novelty heuristic", () => {
  it("scores high novelty with no recent items", () => {
    const score = scoreEvent(
      "brand new interesting content about biotech",
      "general",
      "admin",
      [],
      CONFIG,
    );
    expect(score.factors.novelty).toBeGreaterThan(0.7);
  });

  it("scores low novelty when content matches recent items", () => {
    const recent = [
      "brand new interesting content about biotech catalysts PDUFA",
      "brand new interesting content about biotech catalysts PDUFA",
      "brand new interesting content about biotech catalysts PDUFA",
    ];
    const score = scoreEvent(
      "brand new interesting content about biotech catalysts PDUFA",
      "general",
      "admin",
      recent,
      CONFIG,
    );
    expect(score.factors.novelty).toBeLessThan(0.4);
  });

  it("scores higher novelty for content different from recent items", () => {
    const recent = ["apple banana cherry dessert eating food"];
    const novel = scoreEvent(
      "machine learning transformer attention mechanism",
      "general",
      "admin",
      recent,
      CONFIG,
    );
    const repeat = scoreEvent(
      "apple banana cherry dessert eating food",
      "general",
      "admin",
      recent,
      CONFIG,
    );
    expect(novel.factors.novelty).toBeGreaterThan(repeat.factors.novelty);
  });
});

describe("scoreEvent — mode modifiers", () => {
  it("trading mode amplifies urgency and time_sensitivity factors", () => {
    // Use the same content and compare raw factor scores (not total, which is
    // also affected by per-mode channel amplification rules).
    const adminScore = scoreEvent(
      "urgent deadline today trade position",
      "trading-signals",
      "admin",
      [],
      CONFIG,
    );
    const tradingScore = scoreEvent(
      "urgent deadline today trade position",
      "trading-signals",
      "trading",
      [],
      CONFIG,
    );

    // trading has urgency×1.3 and time_sensitivity×1.4; those raw factors
    // are equal, but the higher mode weights means the weighted aggregate
    // is higher for trading — and trading also amplifies trading-signals channel.
    expect(tradingScore.total).toBeGreaterThan(adminScore.total);
  });

  it("trading mode individual factors are unaffected by mode (factors are content-only)", () => {
    // Factors themselves are content-based heuristics, not mode-dependent.
    // Mode modifiers affect the *weighted sum*, not the per-dimension score.
    const adminScore = scoreEvent("urgent message", "general", "admin", [], CONFIG);
    const tradingScore = scoreEvent("urgent message", "general", "trading", [], CONFIG);
    expect(adminScore.factors.urgency).toBe(tradingScore.factors.urgency);
  });
});

describe("scoreEvent — channel amplification and suppression", () => {
  it("amplifies score for channels_amplified", () => {
    const amplified = scoreEvent("build progress update", "build-log", "deep_work", [], CONFIG);
    const neutral = scoreEvent("build progress update", "general", "deep_work", [], CONFIG);
    expect(amplified.total).toBeGreaterThan(neutral.total);
  });

  it("suppresses score for channels_suppressed", () => {
    const suppressed = scoreEvent(
      "important research update",
      "research-radar",
      "deep_work",
      [],
      CONFIG,
    );
    const neutral = scoreEvent("important research update", "general", "deep_work", [], CONFIG);
    expect(suppressed.total).toBeLessThan(neutral.total);
  });

  it("heavily suppresses all channels when mode has channels_suppressed=['all']", () => {
    const score = scoreEvent("urgent critical emergency", "trading-signals", "social", [], CONFIG);
    // social mode suppresses all channels → 50% reduction
    const baseline = scoreEvent(
      "urgent critical emergency",
      "trading-signals",
      "admin",
      [],
      CONFIG,
    );
    expect(score.total).toBeLessThan(baseline.total);
  });
});

describe("scoreEvent — suppression flag", () => {
  it("marks as suppressed when total < suppression_threshold", () => {
    // deep_work suppression_threshold = 0.65; low-salience content should be suppressed
    const score = scoreEvent("some generic info about nothing", "general", "deep_work", [], CONFIG);
    // Check if it's below threshold
    if (score.total < 0.65) {
      expect(score.suppressed).toBe(true);
    }
  });

  it("marks as not suppressed for high-urgency content in admin mode", () => {
    // admin suppression_threshold = 0.40; urgent content should exceed it
    const score = scoreEvent(
      "URGENT: your OSCE deadline is today, Nir. Irreversible deadline now.",
      "general",
      "admin",
      [],
      CONFIG,
    );
    expect(score.suppressed).toBe(false);
    expect(score.total).toBeGreaterThan(0.4);
  });
});
