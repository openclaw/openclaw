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
  type TerminationCondition,
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
    const [stop, reason] = cond.check(state({ startedAt: Date.now() - 2000 }));
    expect(stop).toBe(true);
    expect(reason).toBe("time_limit");
  });

  it("resets internal state between runs", () => {
    const cond = new TimeLimit(1);
    cond.check(state({ startedAt: Date.now() - 2000 }));
    cond.reset();
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
  it("stops when the first condition fires", async () => {
    const cond = new TextMention("DONE").or(new MaxIterations(10));
    const [stop, reason] = await cond.check(state({ turn: 2, replyText: "DONE" }));
    expect(stop).toBe(true);
    expect(reason).toBe("text_mention:DONE");
  });

  it("stops when the second condition fires", async () => {
    const cond = new TextMention("DONE").or(new MaxIterations(5));
    const [stop, reason] = await cond.check(state({ turn: 5, replyText: "still working" }));
    expect(stop).toBe(true);
    expect(reason).toBe("max_iterations");
  });

  it("does not stop when neither fires", async () => {
    const cond = new TextMention("DONE").or(new MaxIterations(10));
    expect((await cond.check(state({ turn: 3, replyText: "still working" })))[0]).toBe(false);
  });

  it("functional any() alias works", () => {
    expect(any(new TextMention("DONE"), new MaxIterations(5))).toBeInstanceOf(OrCondition);
  });
});

// ─── AndCondition / .and() ───────────────────────────────────────────────────

describe("AndCondition", () => {
  it("does not stop when only one condition fires", async () => {
    const cond = new TextMention("DONE").and(new MaxIterations(5));
    expect((await cond.check(state({ turn: 2, replyText: "DONE" })))[0]).toBe(false);
  });

  it("stops when both conditions fire", async () => {
    const cond = new TextMention("DONE").and(new MaxIterations(5));
    const [stop, reason] = await cond.check(state({ turn: 5, replyText: "DONE" }));
    expect(stop).toBe(true);
    expect(reason).toContain("AND");
  });

  it("functional all() alias works", () => {
    expect(all(new TextMention("DONE"), new MaxIterations(5))).toBeInstanceOf(AndCondition);
  });
});

// ─── Composite nesting ───────────────────────────────────────────────────────

describe("nested composition", () => {
  it("(A | B) & C — stops only when (A or B) AND C", async () => {
    const cond = new TextMention("DONE").or(new ReplyPattern(/summary/i)).and(new MaxIterations(5));
    expect((await cond.check(state({ turn: 2, replyText: "DONE" })))[0]).toBe(false);
    expect((await cond.check(state({ turn: 5, replyText: "DONE" })))[0]).toBe(true);
    expect((await cond.check(state({ turn: 5, replyText: "still going" })))[0]).toBe(false);
  });
});

// ─── Anthropic vs OpenAI behavioral proof ────────────────────────────────────
//
// Claude naturally signals completion early ("DONE" / synthesis with no follow-up)
// GPT keeps running toward the hard limit without a natural completion signal.
//
// With flat MaxIterations(5), both providers burn the full budget.
// With TextMention("DONE").or(MaxIterations(5)), Claude exits at the natural turn.

type MockProvider = "anthropic" | "openai";

async function simulateA2ATurns(
  provider: MockProvider,
  termination: TerminationCondition,
  maxTurns: number,
): Promise<{ turnsUsed: number; exitReason: string | null }> {
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
    const [stop, reason] = await termination.check({ turn, replyText, startedAt });
    if (stop) {
      exitReason = reason;
      break;
    }
  }

  return { turnsUsed, exitReason };
}

describe("Anthropic vs OpenAI — termination algebra behavioral proof", () => {
  const MAX = 5;

  it("flat MaxIterations: both providers burn the full budget", async () => {
    const cond = new MaxIterations(MAX);
    const anthropic = await simulateA2ATurns("anthropic", cond, MAX);
    const openai = await simulateA2ATurns("openai", cond, MAX);

    expect(anthropic.turnsUsed).toBe(MAX);
    expect(openai.turnsUsed).toBe(MAX);
  });

  it("TextMention('DONE').or(MaxIterations): Claude exits early, GPT hits the hard limit", async () => {
    const cond = new TextMention("DONE").or(new MaxIterations(MAX));
    const anthropic = await simulateA2ATurns("anthropic", cond, MAX);
    const openai = await simulateA2ATurns("openai", cond, MAX);

    expect(anthropic.turnsUsed).toBe(2);
    expect(anthropic.exitReason).toBe("text_mention:DONE");

    expect(openai.turnsUsed).toBe(MAX);
    expect(openai.exitReason).toBe("max_iterations");

    expect(anthropic.turnsUsed).toBeLessThan(openai.turnsUsed);
  });

  it("algebra saves turns proportionally to how naturally the model completes", async () => {
    const cond = new TextMention("DONE").or(new MaxIterations(MAX));
    const anthropic = await simulateA2ATurns("anthropic", cond, MAX);
    const openai = await simulateA2ATurns("openai", cond, MAX);

    const savedTurns = openai.turnsUsed - anthropic.turnsUsed;
    const savingPct = (savedTurns / MAX) * 100;

    expect(savedTurns).toBe(3);
    expect(savingPct).toBe(60);
  });
});
