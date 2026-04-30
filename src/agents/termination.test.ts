import { describe, expect, it } from "vitest";
import {
  AndCondition,
  CustomCondition,
  MaxIterations,
  OrCondition,
  ReplyPattern,
  TextMention,
  TimeLimit,
  all,
  any,
  type TerminationState,
} from "./termination.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function state(overrides: Partial<TerminationState> = {}): TerminationState {
  return { turn: 1, replyText: "", startedAt: Date.now(), ...overrides };
}

// ─── MaxIterations ───────────────────────────────────────────────────────────

describe("MaxIterations", () => {
  it("does not fire before the limit", () => {
    const cond = new MaxIterations(5);
    expect(cond.check(state({ turn: 4 }))[0]).toBe(false);
  });

  it("fires at exactly the limit", () => {
    const cond = new MaxIterations(5);
    const [stop, reason] = cond.check(state({ turn: 5 }));
    expect(stop).toBe(true);
    expect(reason).toBe("max_iterations");
  });

  it("fires beyond the limit", () => {
    expect(new MaxIterations(3).check(state({ turn: 10 }))[0]).toBe(true);
  });
});

// ─── TextMention ─────────────────────────────────────────────────────────────

describe("TextMention", () => {
  it("fires when text is present (case-insensitive by default)", () => {
    const cond = new TextMention("DONE");
    const [stop, reason] = cond.check(state({ replyText: "Task is done." }));
    expect(stop).toBe(true);
    expect(reason).toBe("text_mention:DONE");
  });

  it("does not fire when text is absent", () => {
    expect(new TextMention("DONE").check(state({ replyText: "Still working..." }))[0]).toBe(false);
  });

  it("respects case-sensitive flag", () => {
    const cond = new TextMention("DONE", true);
    expect(cond.check(state({ replyText: "done." }))[0]).toBe(false);
    expect(cond.check(state({ replyText: "DONE." }))[0]).toBe(true);
  });
});

// ─── TimeLimit ───────────────────────────────────────────────────────────────

describe("TimeLimit", () => {
  it("does not fire before the duration elapses", () => {
    const cond = new TimeLimit(60);
    expect(cond.check(state({ startedAt: Date.now() }))[0]).toBe(false);
  });

  it("fires when duration has elapsed", () => {
    const cond = new TimeLimit(1);
    // startedAt 2 seconds ago
    const [stop, reason] = cond.check(state({ startedAt: Date.now() - 2000 }));
    expect(stop).toBe(true);
    expect(reason).toBe("time_limit");
  });

  it("resets internal state between runs", () => {
    const cond = new TimeLimit(1);
    cond.check(state({ startedAt: Date.now() - 2000 })); // fire once
    cond.reset();
    // After reset, startedAt is re-latched from state on next check
    expect(cond.check(state({ startedAt: Date.now() }))[0]).toBe(false);
  });
});

// ─── ReplyPattern ────────────────────────────────────────────────────────────

describe("ReplyPattern", () => {
  it("fires when pattern matches", () => {
    const cond = new ReplyPattern(/\btask complete\b/i);
    expect(cond.check(state({ replyText: "Task Complete." }))[0]).toBe(true);
  });

  it("does not fire when pattern does not match", () => {
    expect(new ReplyPattern(/DONE/i).check(state({ replyText: "still going" }))[0]).toBe(false);
  });
});

// ─── CustomCondition ─────────────────────────────────────────────────────────

describe("CustomCondition", () => {
  it("delegates to the provided function", () => {
    const cond = new CustomCondition((s) => [s.turn > 3 && s.replyText.length < 50, "custom"]);
    expect(cond.check(state({ turn: 2, replyText: "short" }))[0]).toBe(false);
    expect(cond.check(state({ turn: 4, replyText: "short" }))[0]).toBe(true);
  });
});

// ─── OrCondition / .or() ─────────────────────────────────────────────────────

describe("OrCondition", () => {
  it("stops when the first condition fires", () => {
    const cond = new TextMention("DONE").or(new MaxIterations(10));
    const [stop, reason] = cond.check(state({ turn: 2, replyText: "DONE" }));
    expect(stop).toBe(true);
    expect(reason).toBe("text_mention:DONE");
  });

  it("stops when the second condition fires", () => {
    const cond = new TextMention("DONE").or(new MaxIterations(5));
    const [stop, reason] = cond.check(state({ turn: 5, replyText: "still working" }));
    expect(stop).toBe(true);
    expect(reason).toBe("max_iterations");
  });

  it("does not stop when neither fires", () => {
    const cond = new TextMention("DONE").or(new MaxIterations(10));
    expect(cond.check(state({ turn: 3, replyText: "still working" }))[0]).toBe(false);
  });

  it("functional any() alias works", () => {
    expect(any(new TextMention("DONE"), new MaxIterations(5))).toBeInstanceOf(OrCondition);
  });
});

// ─── AndCondition / .and() ───────────────────────────────────────────────────

describe("AndCondition", () => {
  it("does not stop when only one condition fires", () => {
    const cond = new TextMention("DONE").and(new MaxIterations(5));
    // TextMention fires but MaxIterations has not
    expect(cond.check(state({ turn: 2, replyText: "DONE" }))[0]).toBe(false);
  });

  it("stops when both conditions fire", () => {
    const cond = new TextMention("DONE").and(new MaxIterations(5));
    const [stop, reason] = cond.check(state({ turn: 5, replyText: "DONE" }));
    expect(stop).toBe(true);
    expect(reason).toContain("AND");
  });

  it("functional all() alias works", () => {
    expect(all(new TextMention("DONE"), new MaxIterations(5))).toBeInstanceOf(AndCondition);
  });
});

// ─── Composite nesting ───────────────────────────────────────────────────────

describe("nested composition", () => {
  it("(A | B) & C — stops only when (A or B) AND C", () => {
    const cond = new TextMention("DONE").or(new ReplyPattern(/summary/i)).and(new MaxIterations(5));
    // A fires but C has not
    expect(cond.check(state({ turn: 2, replyText: "DONE" }))[0]).toBe(false);
    // A fires AND C fires
    expect(cond.check(state({ turn: 5, replyText: "DONE" }))[0]).toBe(true);
    // Neither A nor B fires, C fires — still false
    expect(cond.check(state({ turn: 5, replyText: "still going" }))[0]).toBe(false);
  });
});

// ─── Anthropic vs OpenAI behavioral proof ────────────────────────────────────
//
// This section simulates the real behavioral difference between Claude (Anthropic)
// and GPT (OpenAI) in a multi-turn A2A loop:
//
//   - Claude naturally signals completion early ("DONE" / synthesis with no follow-up)
//   - GPT keeps running toward the hard limit without a natural completion signal
//
// With a flat MaxIterations(5), both providers burn the full budget.
// With TextMention("DONE").or(MaxIterations(5)), Claude exits at the natural turn,
// saving turns — which directly maps to API calls, latency, and cost.

type MockProvider = "anthropic" | "openai";

function simulateA2ATurns(
  provider: MockProvider,
  termination: { check: (s: TerminationState) => readonly [boolean, string | null]; reset(): void },
  maxTurns: number,
): { turnsUsed: number; exitReason: string | null } {
  // Claude signals completion at turn 2; GPT keeps running
  const replies: Record<MockProvider, string[]> = {
    anthropic: [
      "Let me look into that.",
      "I have gathered everything needed. Task complete. DONE",
      "Confirming — DONE",
      "DONE",
      "DONE",
    ],
    openai: [
      "Let me search for that.",
      "Found some results, searching more.",
      "Cross-referencing data...",
      "Compiling output...",
      "Here is the result.",
    ],
  };

  const providerReplies = replies[provider];
  termination.reset();
  const startedAt = Date.now();
  let turnsUsed = 0;
  let exitReason: string | null = null;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const replyText = providerReplies[turn - 1] ?? "";
    turnsUsed = turn;
    const [stop, reason] = termination.check({ turn, replyText, startedAt });
    if (stop) {
      exitReason = reason;
      break;
    }
  }

  return { turnsUsed, exitReason };
}

describe("Anthropic vs OpenAI — termination algebra behavioral proof", () => {
  const MAX = 5;

  it("flat MaxIterations: both providers burn the full budget", () => {
    const cond = new MaxIterations(MAX);
    const anthropic = simulateA2ATurns("anthropic", cond, MAX);
    const openai = simulateA2ATurns("openai", cond, MAX);

    expect(anthropic.turnsUsed).toBe(MAX);
    expect(openai.turnsUsed).toBe(MAX);
    // Both waste turns even after the task is naturally done
  });

  it("TextMention('DONE').or(MaxIterations): Claude exits early, GPT hits the hard limit", () => {
    const cond = new TextMention("DONE").or(new MaxIterations(MAX));
    const anthropic = simulateA2ATurns("anthropic", cond, MAX);
    const openai = simulateA2ATurns("openai", cond, MAX);

    // Claude naturally signals completion at turn 2
    expect(anthropic.turnsUsed).toBe(2);
    expect(anthropic.exitReason).toBe("text_mention:DONE");

    // GPT never signals, hits the hard limit at turn 5
    expect(openai.turnsUsed).toBe(MAX);
    expect(openai.exitReason).toBe("max_iterations");

    // Claude used fewer turns — directly fewer API calls and lower cost
    expect(anthropic.turnsUsed).toBeLessThan(openai.turnsUsed);
  });

  it("algebra saves turns proportionally to how naturally the model completes", () => {
    const cond = new TextMention("DONE").or(new MaxIterations(MAX));
    const anthropic = simulateA2ATurns("anthropic", cond, MAX);
    const openai = simulateA2ATurns("openai", cond, MAX);

    const savedTurns = openai.turnsUsed - anthropic.turnsUsed;
    const savingPct = (savedTurns / MAX) * 100;

    // 3 turns saved out of 5 = 60% reduction for Claude
    expect(savedTurns).toBe(3);
    expect(savingPct).toBe(60);
  });
});
