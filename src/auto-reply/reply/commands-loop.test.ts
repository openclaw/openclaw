// Tests for the /loop command parser.
import { describe, expect, it } from "vitest";
import { parseLoopCommand, formatLoopResultReport } from "./commands-loop.js";

describe("parseLoopCommand", () => {
  it("parses a basic loop command", () => {
    const result = parseLoopCommand("/loop build a web server");
    expect(result).toEqual({
      task: "build a web server",
      maxIterations: 10,
      tokenBudget: undefined,
    });
  });

  it("parses with custom max-iterations", () => {
    const result = parseLoopCommand("/loop deploy the app --max-iterations 5");
    expect(result).toEqual({
      task: "deploy the app",
      maxIterations: 5,
      tokenBudget: undefined,
    });
  });

  it("parses with token budget", () => {
    const result = parseLoopCommand("/loop refactor code --budget 100000");
    expect(result).toEqual({
      task: "refactor code",
      maxIterations: 10,
      tokenBudget: 100000,
    });
  });

  it("parses with both flags", () => {
    const result = parseLoopCommand("/loop write tests --max-iterations 3 --budget 50000");
    expect(result).toEqual({
      task: "write tests",
      maxIterations: 3,
      tokenBudget: 50000,
    });
  });

  it("returns null for empty command", () => {
    expect(parseLoopCommand("/loop")).toBeNull();
  });

  it("returns null for non-loop command", () => {
    expect(parseLoopCommand("/goal start task")).toBeNull();
  });

  it("clamps max-iterations to valid range (uses default if out of range)", () => {
    const result = parseLoopCommand("/loop task --max-iterations 200");
    // Out-of-range flags are stripped and default applies
    expect(result).toEqual({ task: "task", maxIterations: 10, tokenBudget: undefined });
  });

  it("handles flags in any order", () => {
    const result = parseLoopCommand("/loop task --budget 30000 --max-iterations 7");
    expect(result).toEqual({
      task: "task",
      maxIterations: 7,
      tokenBudget: 30000,
    });
  });
});

describe("formatLoopResultReport", () => {
  it("formats a completed result", () => {
    const text = formatLoopResultReport({
      success: true,
      reason: "completed",
      iterations: 3,
      tokenUsage: 15000,
      task: "build app",
      summary: "Built the web server with Express and React",
    });
    expect(text).toContain("✅");
    expect(text).toContain("completed");
    expect(text).toContain("Iterations: 3");
    expect(text).toContain("Token usage: ~15,000");
    expect(text).toContain("Express and React");
  });
});
