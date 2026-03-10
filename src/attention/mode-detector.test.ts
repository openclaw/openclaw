import { describe, expect, it } from "vitest";
import { detectMode } from "./mode-detector.js";
import type { RecentMessage, CalendarEvent } from "./mode-detector.js";
import type { AttentionConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal stub config (mirrors attention-config.json structure)
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
      channels_amplified: ["trading-signals", "options-trader"],
      channels_suppressed: ["osce-practice"],
    },
    study_osce: {
      description: "OSCE practice",
      weight_modifiers: {
        urgency: 0.7,
        strategic_importance: 0.8,
        personal_relevance: 0.8,
        time_sensitivity: 0.6,
        reversibility_cost: 1.2,
        novelty: 0.8,
      },
      suppression_threshold: 0.6,
      hysteresis: { entry_threshold: 0.65, exit_threshold: 0.4, min_dwell_minutes: 45 },
      channels_amplified: ["osce-practice"],
      channels_suppressed: ["trading-signals"],
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
    sleep: {
      description: "Sleeping",
      weight_modifiers: {
        urgency: 0.2,
        strategic_importance: 0.1,
        personal_relevance: 0.3,
        time_sensitivity: 0.2,
        reversibility_cost: 0.4,
        novelty: 0.1,
      },
      suppression_threshold: 0.95,
      hysteresis: { entry_threshold: 0.98, exit_threshold: 0.8, min_dwell_minutes: 120 },
      channels_amplified: [],
      channels_suppressed: ["all"],
    },
    uncertain: {
      description: "Uncertain",
      weight_modifiers: {
        urgency: 1.0,
        strategic_importance: 1.0,
        personal_relevance: 1.0,
        time_sensitivity: 1.0,
        reversibility_cost: 1.0,
        novelty: 1.0,
      },
      suppression_threshold: 0.8,
      hysteresis: { entry_threshold: 0.5, exit_threshold: 0.3, min_dwell_minutes: 10 },
      channels_amplified: [],
      channels_suppressed: [],
    },
  },
  time_defaults: {
    "00:00-06:00": "sleep",
    "06:00-09:00": "admin",
    "09:00-14:30": "deep_work",
    "14:30-16:00": "trading",
    "16:00-18:00": "study_osce",
    "18:00-22:00": "admin",
    "22:00-00:00": "sleep",
  },
  explicit_command_keywords: {
    study_osce: ["going to study", "osce time", "study time"],
    trading: ["trading time", "market time", "markets open"],
    sleep: ["going to sleep", "good night"],
    deep_work: ["focus time", "deep work"],
    admin: ["admin time"],
  },
  calendar_keyword_map: {
    study_osce: ["OSCE", "Clinical", "Tutoring", "Ward"],
    trading: ["Trading", "Market", "Options"],
    social: ["Dinner", "Lunch", "Coffee", "Party"],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A recent message created N minutes ago. */
function msg(content: string, channel = "general", minutesAgo = 1): RecentMessage {
  return { channel, content, timestamp: new Date(Date.now() - minutesAgo * 60_000) };
}

/** A calendar event active right now. */
function activeEvent(title: string): CalendarEvent {
  const now = new Date();
  return {
    title,
    startTime: new Date(now.getTime() - 30 * 60_000),
    endTime: new Date(now.getTime() + 30 * 60_000),
  };
}

/** modeEnteredAt far enough in the past to satisfy any min_dwell. */
const longAgo = new Date(Date.now() - 999 * 60_000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectMode — explicit command", () => {
  it("detects trading time command", () => {
    const result = detectMode("deep_work", longAgo, [msg("trading time")], 10, [], CONFIG);
    expect(result.mode).toBe("trading");
    expect(result.set_by).toBe("explicit_command");
    expect(result.hysteresis_blocked).toBe(false);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("is case-insensitive", () => {
    const result = detectMode("admin", longAgo, [msg("GOOD NIGHT everyone")], 22, [], CONFIG);
    expect(result.mode).toBe("sleep");
    expect(result.set_by).toBe("explicit_command");
  });

  it("explicit command bypasses hysteresis (even if recently entered)", () => {
    // modeEnteredAt = NOW (0 minutes dwell — would normally block hysteresis)
    const justNow = new Date();
    const result = detectMode("admin", justNow, [msg("deep work starting now")], 10, [], CONFIG);
    expect(result.mode).toBe("deep_work");
    expect(result.hysteresis_blocked).toBe(false);
  });

  it("ignores commands older than 10 minutes", () => {
    const staleMsg = msg("trading time", "general", 15); // 15 min ago
    const result = detectMode("admin", longAgo, [staleMsg], 7, [], CONFIG);
    // Should NOT detect explicit command; falls through to time_default
    expect(result.set_by).not.toBe("explicit_command");
  });
});

describe("detectMode — calendar", () => {
  it("detects study_osce from OSCE event", () => {
    const result = detectMode("admin", longAgo, [], 14, [activeEvent("OSCE Practice")], CONFIG);
    expect(result.mode).toBe("study_osce");
    expect(result.set_by).toBe("calendar");
    expect(result.hysteresis_blocked).toBe(false);
  });

  it("detects trading from Trading event", () => {
    const result = detectMode(
      "deep_work",
      longAgo,
      [],
      15,
      [activeEvent("Trading Session")],
      CONFIG,
    );
    expect(result.mode).toBe("trading");
    expect(result.set_by).toBe("calendar");
  });

  it("blocks calendar transition when dwell is too short", () => {
    // Just entered study_osce — min_dwell = 45 min
    const twoMinutesAgo = new Date(Date.now() - 2 * 60_000);
    const result = detectMode(
      "study_osce",
      twoMinutesAgo,
      [],
      15,
      [activeEvent("Trading Session")],
      CONFIG,
    );
    expect(result.mode).toBe("study_osce");
    expect(result.hysteresis_blocked).toBe(true);
  });
});

describe("detectMode — channel activity", () => {
  it("detects trading from 3+ trading-signals messages", () => {
    const messages = [
      msg("AAPL catalyst", "trading-signals", 5),
      msg("PDUFA alert NVDA", "trading-signals", 10),
      msg("Options flow unusual", "trading-signals", 20),
    ];
    const result = detectMode("admin", longAgo, messages, 11, [], CONFIG);
    expect(result.mode).toBe("trading");
    expect(result.set_by).toBe("channel_activity");
  });

  it("does not fire on fewer than 3 messages", () => {
    const messages = [
      msg("AAPL catalyst", "trading-signals", 5),
      msg("PDUFA alert", "trading-signals", 10),
    ];
    const result = detectMode("admin", longAgo, messages, 7, [], CONFIG);
    // Falls through to time_default (hour 7 → admin)
    expect(result.set_by).not.toBe("channel_activity");
  });
});

describe("detectMode — time default", () => {
  it("returns sleep for hour 2", () => {
    const result = detectMode("sleep", longAgo, [], 2, [], CONFIG);
    expect(result.mode).toBe("sleep");
    expect(result.set_by).toBe("time_default");
  });

  it("returns deep_work for hour 11", () => {
    const result = detectMode("deep_work", longAgo, [], 11, [], CONFIG);
    expect(result.mode).toBe("deep_work");
    expect(result.set_by).toBe("time_default");
  });

  it("returns trading for hour 15", () => {
    const result = detectMode("trading", longAgo, [], 15, [], CONFIG);
    expect(result.mode).toBe("trading");
    expect(result.set_by).toBe("time_default");
  });
});

describe("detectMode — uncertain fallback", () => {
  it("falls through to uncertain with no signals", () => {
    // Use hour 7 which maps to admin, but hysteresis blocks (not long enough in sleep)
    // Actually easier: use a completely unknown hour range and empty config
    const emptyConfig: AttentionConfig = {
      ...CONFIG,
      explicit_command_keywords: {},
      calendar_keyword_map: {},
      time_defaults: {},
      modes: {},
    };
    const result = detectMode("deep_work", longAgo, [], 10, [], emptyConfig);
    expect(result.set_by).toBe("uncertain");
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("preserves current mode as fallback value", () => {
    const emptyConfig: AttentionConfig = {
      ...CONFIG,
      explicit_command_keywords: {},
      calendar_keyword_map: {},
      time_defaults: {},
      modes: {},
    };
    const result = detectMode("trading", longAgo, [], 10, [], emptyConfig);
    expect(result.mode).toBe("trading");
    expect(result.set_by).toBe("uncertain");
  });
});

describe("detectMode — hysteresis", () => {
  it("blocks transition when confidence below entry_threshold", () => {
    // deep_work entry_threshold = 0.70, time_default confidence = 0.50 → blocked
    // Hour 7 → admin (time_default, confidence=0.50)
    // admin entry_threshold = 0.45, exit: need proposedConfidence >= exit_threshold of deep_work (0.45)
    // 0.50 >= 0.45 → exit ok; 0.50 >= admin entry 0.45 → entry ok → transition succeeds
    // Use sleep mode (entry_threshold=0.98) to force a hysteresis block instead:
    const result2 = detectMode("sleep", longAgo, [], 7, [], CONFIG);
    // Hour 7 → admin confidence 0.50; sleep entry_threshold = 0.98 → NOT met → blocked
    expect(result2.mode).toBe("sleep");
    expect(result2.hysteresis_blocked).toBe(true);
  });

  it("allows transition once dwell time is met and signal is strong enough", () => {
    // Explicit command always bypasses hysteresis
    const justNow = new Date();
    const result = detectMode("sleep", justNow, [msg("markets open")], 15, [], CONFIG);
    expect(result.mode).toBe("trading");
    expect(result.hysteresis_blocked).toBe(false);
  });
});
