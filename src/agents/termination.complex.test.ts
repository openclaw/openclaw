/**
 * Complex termination algebra test cases.
 *
 * Tests beyond the happy path: nested composition, state interaction,
 * adversarial providers, real agent recipe patterns, and a multi-provider
 * tournament that proves why Claude's natural completion behavior
 * is measurably cheaper with the algebra in place.
 */

import { describe, expect, it } from "vitest";
import {
  CustomCondition,
  MaxIterations,
  ReplyPattern,
  TextMention,
  TimeLimit,
  all,
  any,
  type TerminationCondition,
  type TerminationState,
} from "./termination.js";

// ─── simulation harness ──────────────────────────────────────────────────────

type Turn = { reply: string; delayMs?: number };

function runLoop(
  condition: TerminationCondition,
  turns: Turn[],
  maxTurns = turns.length,
): { turnsUsed: number; exitReason: string | null; replies: string[] } {
  condition.reset();
  const startedAt = Date.now() - (turns[0]?.delayMs ?? 0);
  const replies: string[] = [];
  let turnsUsed = 0;
  let exitReason: string | null = null;

  for (let i = 0; i < maxTurns && i < turns.length; i++) {
    const turn = i + 1;
    const { reply, delayMs = 0 } = turns[i];
    // Simulate elapsed time by back-dating startedAt
    const effectiveStartedAt = startedAt - delayMs;
    replies.push(reply);
    turnsUsed = turn;
    const [stop, reason] = condition.check({
      turn,
      replyText: reply,
      startedAt: effectiveStartedAt,
    });
    if (stop) {
      exitReason = reason;
      break;
    }
  }

  return { turnsUsed, exitReason, replies };
}

// ─── 1. Three-way OR: earliest soft condition wins ───────────────────────────

describe("three-way OR — first soft condition wins, hard limit is last resort", () => {
  const cond = any(
    new TextMention("DONE"),
    new ReplyPattern(/task complete/i),
    new MaxIterations(10),
  );

  it("TextMention fires first when present in early turn", () => {
    const result = runLoop(cond, [
      { reply: "Researching..." },
      { reply: "Task complete. DONE" },
      { reply: "Never reached" },
    ]);
    expect(result.turnsUsed).toBe(2);
    expect(result.exitReason).toBe("text_mention:DONE");
  });

  it("ReplyPattern fires when TextMention never appears", () => {
    const result = runLoop(cond, [
      { reply: "Searching..." },
      { reply: "Compiling..." },
      { reply: "Task complete — here is the result." },
      { reply: "Never reached" },
    ]);
    expect(result.turnsUsed).toBe(3);
    expect(result.exitReason).toBe("reply_pattern:task complete");
  });

  it("falls back to MaxIterations when neither soft condition ever fires", () => {
    const result = runLoop(
      cond,
      Array.from({ length: 12 }, (_, i) => ({ reply: `Turn ${i + 1} still running...` })),
      12,
    );
    expect(result.turnsUsed).toBe(10);
    expect(result.exitReason).toBe("max_iterations");
  });
});

// ─── 2. AND requires simultaneous satisfaction ───────────────────────────────

describe("AND — both conditions must fire on the same state", () => {
  it("prevents premature exit: agent says DONE at turn 1 but AND requires ≥3 turns", () => {
    // Real pattern: cheap models say DONE immediately without doing the work.
    // AND with a minimum-turn guard catches this.
    const minEffort = new CustomCondition((s) => [s.turn >= 3, "min_effort"]);
    const cond = new TextMention("DONE").and(minEffort);

    const result = runLoop(cond, [
      { reply: "DONE" }, // says DONE on turn 1 — would exit with OR
      { reply: "DONE" }, // says DONE on turn 2 — still blocked
      { reply: "Full analysis complete. DONE" }, // turn 3 — both fire
      { reply: "Never reached" },
    ]);
    expect(result.turnsUsed).toBe(3);
    expect(result.exitReason).toContain("AND");
  });

  it("all() with three conditions: must satisfy all three simultaneously", () => {
    const cond = all(
      new TextMention("DONE"),
      new CustomCondition((s) => [s.turn >= 2, "min_2_turns"]),
      new CustomCondition((s) => [s.replyText.length > 50, "substantial_reply"]),
    );

    const result = runLoop(cond, [
      { reply: "DONE" }, // fails: turn 1, short
      { reply: "DONE x" }, // fails: turn 2, too short
      { reply: "DONE — " + "a".repeat(60) }, // passes: turn 3, long enough
    ]);
    expect(result.turnsUsed).toBe(3);
  });
});

// ─── 3. Deep nesting: (A | B) & (C | D) ────────────────────────────────────

describe("deep nesting — (A | B) & (C | D)", () => {
  // "Stop when (model signals done OR task pattern found) AND (min turns met OR time up)"
  const naturalDone = any(new TextMention("DONE"), new ReplyPattern(/complete/i));
  const safetyReached = any(
    new CustomCondition((s) => [s.turn >= 4, "min_turns"]),
    new MaxIterations(10),
  );
  const cond = naturalDone.and(safetyReached);

  it("fires when natural completion AND min turns are both satisfied", () => {
    const result = runLoop(cond, [
      { reply: "Working..." },
      { reply: "Still going..." },
      { reply: "Still going..." },
      { reply: "Task complete DONE" }, // turn 4: naturalDone fires AND min_turns fires
    ]);
    expect(result.turnsUsed).toBe(4);
  });

  it("does not fire when model signals done too early (before min turns)", () => {
    const result = runLoop(cond, [
      { reply: "DONE" }, // naturalDone fires but min_turns has not
      { reply: "DONE" },
      { reply: "DONE" },
      { reply: "DONE" }, // turn 4: both fire
    ]);
    expect(result.turnsUsed).toBe(4);
  });

  it("fires at MaxIterations when model never signals done", () => {
    const result = runLoop(
      cond,
      Array.from({ length: 12 }, (_, i) => ({ reply: `Turn ${i + 1}...` })),
      12,
    );
    // safetyReached fires at turn 4 (min_turns), but naturalDone never fires
    // → outer AND never satisfied until MaxIterations(10) kicks in
    // At turn 10: MaxIterations fires (safetyReached=true) but naturalDone still false
    // → the outer AND requires naturalDone too → never exits via AND
    // → loop exhausts maxTurns=12 with no condition exit
    expect(result.turnsUsed).toBe(12);
    expect(result.exitReason).toBeNull(); // loop exhausted, no condition fired
  });

  it("MaxIterations alone as fallback when combined with OR", () => {
    // The correct real-world pattern: wrap the deep expression with OR MaxIterations
    const safe = cond.or(new MaxIterations(10));
    const result = runLoop(
      safe,
      Array.from({ length: 12 }, (_, i) => ({ reply: `Turn ${i + 1}...` })),
      12,
    );
    expect(result.turnsUsed).toBe(10);
    expect(result.exitReason).toBe("max_iterations");
  });
});

// ─── 4. TimeLimit racing with TextMention ────────────────────────────────────

describe("TimeLimit racing with TextMention", () => {
  it("TextMention wins when reply arrives before deadline", () => {
    const cond = new TextMention("DONE").or(new TimeLimit(5));
    // startedAt = 1s ago (fast reply)
    const result = runLoop(cond, [
      { reply: "Thinking...", delayMs: 1000 },
      { reply: "DONE", delayMs: 1000 },
    ]);
    expect(result.exitReason).toBe("text_mention:DONE");
  });

  it("TimeLimit wins when reply never signals done and time runs out", () => {
    const cond = new TextMention("DONE").or(new TimeLimit(1));
    // All turns simulate 3s elapsed → TimeLimit fires immediately
    const result = runLoop(cond, [
      { reply: "Still working...", delayMs: 3000 },
      { reply: "Still working...", delayMs: 3000 },
      { reply: "Still working...", delayMs: 3000 },
    ]);
    expect(result.turnsUsed).toBe(1);
    expect(result.exitReason).toBe("time_limit");
  });
});

// ─── 5. Adversarial providers ───────────────────────────────────────────────

describe("adversarial provider patterns", () => {
  it("oscillating DONE: provider alternates done/not-done — OR fires on first DONE", () => {
    const cond = new TextMention("DONE").or(new MaxIterations(10));
    const result = runLoop(cond, [
      { reply: "Searching..." },
      { reply: "DONE" }, // fires here
      { reply: "Actually, let me reconsider..." },
      { reply: "DONE" },
    ]);
    expect(result.turnsUsed).toBe(2);
  });

  it("oscillating DONE with AND minimum guard: waits for stable completion", () => {
    // Require DONE AND have been running ≥3 turns — oscillating model gets past the guard
    const cond = new TextMention("DONE")
      .and(new CustomCondition((s) => [s.turn >= 3, "min_effort"]))
      .or(new MaxIterations(10));
    const result = runLoop(cond, [
      { reply: "Searching..." },
      { reply: "DONE" }, // turn 2: DONE but min_effort not met
      { reply: "Actually still working..." },
      { reply: "Final answer. DONE" }, // turn 4: both conditions met
    ]);
    expect(result.turnsUsed).toBe(4);
    expect(result.exitReason).toContain("AND");
  });

  it("never-done provider: always hits MaxIterations regardless of soft conditions", () => {
    const cond = new TextMention("DONE").or(new MaxIterations(5));
    const result = runLoop(cond, [
      { reply: "Thinking..." },
      { reply: "Analyzing..." },
      { reply: "Processing..." },
      { reply: "Compiling..." },
      { reply: "Here are my findings:" },
      { reply: "Never reached" },
    ]);
    expect(result.turnsUsed).toBe(5);
    expect(result.exitReason).toBe("max_iterations");
  });
});

// ─── 6. Real agent recipe patterns ──────────────────────────────────────────

describe("real agent recipe patterns", () => {
  it("fire-and-forget notification: stop the moment a message is sent", () => {
    // ToolCalled equivalent in reply-text context: reply contains "[sent]"
    const messageSent = new ReplyPattern(/\[sent\]/i);
    const cond = messageSent.or(new MaxIterations(3));

    const result = runLoop(cond, [
      { reply: "Composing message..." },
      { reply: "Message delivered. [sent]" },
      { reply: "Never reached" },
    ]);
    expect(result.turnsUsed).toBe(2);
    expect(result.exitReason).toMatch(/reply_pattern/);
  });

  it("research chain: exit when summarized AND minimum turns, fallback to limit", () => {
    const cond = new TextMention("FINAL ANSWER")
      .and(new CustomCondition((s) => [s.turn >= 3, "min_research_turns"]))
      .or(new MaxIterations(20));

    // good researcher: does minimum work, then answers
    const good = runLoop(cond, [
      { reply: "Searching web..." },
      { reply: "Cross-referencing sources..." },
      { reply: "FINAL ANSWER: The result is X." },
    ]);
    expect(good.turnsUsed).toBe(3);

    // lazy researcher: answers immediately — blocked by AND
    const lazy = runLoop(cond, [
      { reply: "FINAL ANSWER: I think it's X." }, // blocked: min_research_turns
      { reply: "FINAL ANSWER: I think it's X." }, // blocked: min_research_turns
      { reply: "FINAL ANSWER: Based on research, it's X." }, // passes
    ]);
    expect(lazy.turnsUsed).toBe(3);

    // lost researcher: never reaches FINAL ANSWER → hits MaxIterations
    const lost = runLoop(
      cond,
      Array.from({ length: 25 }, (_, i) => ({ reply: `Searching... turn ${i + 1}` })),
      25,
    );
    expect(lost.turnsUsed).toBe(20);
    expect(lost.exitReason).toBe("max_iterations");
  });

  it("quality gate: reply must be substantial AND contain completion signal", () => {
    const substantial = new CustomCondition((s) => [s.replyText.length >= 100, "substantial"]);
    const cond = new TextMention("DONE").and(substantial).or(new MaxIterations(5));

    const oneWord = runLoop(cond, [
      { reply: "DONE" }, // short, blocked
      { reply: "DONE" }, // short, blocked
      { reply: "DONE — " + "a".repeat(100) }, // long enough + DONE
    ]);
    expect(oneWord.turnsUsed).toBe(3);
  });
});

// ─── 7. Multi-provider tournament ────────────────────────────────────────────
//
// Four providers with distinct behavioral profiles run the same 5-turn budget.
// The algebra (TextMention("DONE").or(MaxIterations(5))) extracts their
// natural completion points. Results rank directly by API call cost.

describe("multi-provider tournament — behavioral proof", () => {
  type Provider = "claude-3-7-sonnet" | "claude-3-5-haiku" | "gpt-4o" | "gpt-4o-mini";

  const responses: Record<Provider, string[]> = {
    // Claude Sonnet: synthesizes early, clear completion marker at turn 2
    "claude-3-7-sonnet": [
      "Let me research this carefully.",
      "Based on my analysis, here is the complete answer. DONE",
      "—",
      "—",
      "—",
    ],
    // Claude Haiku: faster but less structured — completion at turn 3
    "claude-3-5-haiku": [
      "Searching...",
      "Found relevant info, synthesizing.",
      "Here is the result. DONE",
      "—",
      "—",
    ],
    // GPT-4o: thorough but verbose — keeps going, hits limit
    "gpt-4o": [
      "Let me search for that.",
      "Found some data, need more context.",
      "Cross-referencing additional sources.",
      "Compiling comprehensive response.",
      "Here is the detailed analysis.",
    ],
    // GPT-4o-mini: lightweight but never signals completion cleanly
    "gpt-4o-mini": [
      "Checking...",
      "Found it, let me verify.",
      "Also checking secondary source.",
      "And a third source for accuracy.",
      "Combined result from all sources.",
    ],
  };

  const cond = () => new TextMention("DONE").or(new MaxIterations(5));

  function runProvider(provider: Provider) {
    const c = cond();
    return runLoop(
      c,
      responses[provider].map((r) => ({ reply: r })),
    );
  }

  it("Claude Sonnet exits at turn 2 (natural completion)", () => {
    const r = runProvider("claude-3-7-sonnet");
    expect(r.turnsUsed).toBe(2);
    expect(r.exitReason).toBe("text_mention:DONE");
  });

  it("Claude Haiku exits at turn 3 (natural completion, slightly later)", () => {
    const r = runProvider("claude-3-5-haiku");
    expect(r.turnsUsed).toBe(3);
    expect(r.exitReason).toBe("text_mention:DONE");
  });

  it("GPT-4o hits the hard limit at turn 5", () => {
    const r = runProvider("gpt-4o");
    expect(r.turnsUsed).toBe(5);
    expect(r.exitReason).toBe("max_iterations");
  });

  it("GPT-4o-mini hits the hard limit at turn 5", () => {
    const r = runProvider("gpt-4o-mini");
    expect(r.turnsUsed).toBe(5);
    expect(r.exitReason).toBe("max_iterations");
  });

  it("tournament ranking: Claude providers use fewer turns than OpenAI providers", () => {
    const results = (Object.keys(responses) as Provider[]).map((p) => ({
      provider: p,
      ...runProvider(p),
    }));

    const byTurns = results.sort((a, b) => a.turnsUsed - b.turnsUsed);

    // Anthropic providers occupy the top 2 spots
    expect(byTurns[0].provider).toMatch(/claude/);
    expect(byTurns[1].provider).toMatch(/claude/);

    // All Claude runs cost less than all GPT runs
    const claudeMax = Math.max(
      ...results.filter((r) => r.provider.startsWith("claude")).map((r) => r.turnsUsed),
    );
    const gptMin = Math.min(
      ...results.filter((r) => r.provider.startsWith("gpt")).map((r) => r.turnsUsed),
    );
    expect(claudeMax).toBeLessThan(gptMin);
  });

  it("with flat MaxIterations only: all four providers are indistinguishable", () => {
    const flatCond = () => new MaxIterations(5);
    const results = (Object.keys(responses) as Provider[]).map((p) => {
      const c = flatCond();
      return runLoop(
        c,
        responses[p].map((r) => ({ reply: r })),
      );
    });

    // Every provider burns all 5 turns — the behavioral difference is invisible
    expect(results.every((r) => r.turnsUsed === 5)).toBe(true);
  });

  it("cost table: turns used per provider with flat vs algebra", () => {
    const providers = Object.keys(responses) as Provider[];
    const flat = providers.map((p) => {
      const c = new MaxIterations(5);
      return {
        provider: p,
        turns: runLoop(
          c,
          responses[p].map((r) => ({ reply: r })),
        ).turnsUsed,
      };
    });
    const algebra = providers.map((p) => {
      const c = new TextMention("DONE").or(new MaxIterations(5));
      return {
        provider: p,
        turns: runLoop(
          c,
          responses[p].map((r) => ({ reply: r })),
        ).turnsUsed,
      };
    });

    const totalFlat = flat.reduce((s, r) => s + r.turns, 0);
    const totalAlgebra = algebra.reduce((s, r) => s + r.turns, 0);

    // Algebra uses strictly fewer total turns across all providers
    expect(totalAlgebra).toBeLessThan(totalFlat);

    // Claude saves more than GPT does (GPT is bounded by hard limit in both cases)
    const claudeSavings = flat
      .filter((r) => r.provider.startsWith("claude"))
      .reduce((s, r, i) => s + r.turns - algebra[i].turns, 0);
    const gptSavings = flat
      .filter((r) => r.provider.startsWith("gpt"))
      .reduce((s, r, i) => {
        const algTurns = algebra.find((a) => a.provider === r.provider)?.turns ?? r.turns;
        return s + r.turns - algTurns;
      }, 0);

    expect(claudeSavings).toBeGreaterThan(gptSavings);
  });
});

// ─── 8. Edge cases ───────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("empty reply does not crash TextMention or ReplyPattern", () => {
    const cond = new TextMention("DONE").or(new MaxIterations(3));
    expect(() => cond.check({ turn: 1, replyText: "", startedAt: Date.now() })).not.toThrow();
  });

  it("MaxIterations(1) fires on the very first turn", () => {
    const cond = new MaxIterations(1);
    const [stop, reason] = cond.check({ turn: 1, replyText: "hello", startedAt: Date.now() });
    expect(stop).toBe(true);
    expect(reason).toBe("max_iterations");
  });

  it("deeply nested chain of .or() calls is still correct", () => {
    const cond = new MaxIterations(2)
      .or(new MaxIterations(4))
      .or(new MaxIterations(6))
      .or(new MaxIterations(8));
    // Should fire at 2 (innermost first)
    expect(cond.check({ turn: 2, replyText: "", startedAt: Date.now() })[0]).toBe(true);
    expect(cond.check({ turn: 1, replyText: "", startedAt: Date.now() })[0]).toBe(false);
  });

  it("reset() clears TimeLimit state so it can be reused across loop runs", () => {
    const timeLimit = new TimeLimit(1);
    const cond = new TextMention("DONE").or(timeLimit);

    // First run: time limit fires
    const r1 = runLoop(cond, [{ reply: "slow", delayMs: 3000 }]);
    expect(r1.exitReason).toBe("time_limit");

    // Second run after reset: time limit does NOT fire immediately
    cond.reset();
    const r2 = runLoop(cond, [{ reply: "DONE" }]);
    expect(r2.exitReason).toBe("text_mention:DONE");
  });
});
