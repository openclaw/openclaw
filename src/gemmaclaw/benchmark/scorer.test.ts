import { describe, expect, it } from "vitest";
import { scoreDeterministic, buildJudgePrompt, parseJudgeResponse } from "./scorer.js";
import type { BenchmarkTask } from "./tasks.js";

const mockTask = (overrides: Partial<BenchmarkTask> = {}): BenchmarkTask => ({
  id: "test_task",
  name: "Test Task",
  category: "instruction_following",
  difficulty: "easy",
  prompt: "Test prompt",
  grading: {
    type: "exact_match",
    expected: ["hello", "world"],
    maxScore: 10,
  },
  mock: {
    expectedOutput: "hello world",
  },
  ...overrides,
});

describe("scoreDeterministic", () => {
  it("scores exact match correctly", () => {
    const task = mockTask();
    const result = scoreDeterministic("hello world", task);
    expect(result.score).toBe(10);
    expect(result.percentage).toBe(100);
    expect(result.passed).toBe(true);
    expect(result.method).toBe("deterministic");
  });

  it("scores partial match", () => {
    const task = mockTask();
    const result = scoreDeterministic("hello there", task);
    expect(result.score).toBe(5);
    expect(result.percentage).toBe(50);
    expect(result.passed).toBe(false);
  });

  it("scores zero for no match", () => {
    const task = mockTask();
    const result = scoreDeterministic("completely different", task);
    expect(result.score).toBe(0);
    expect(result.percentage).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("handles case-insensitive matching", () => {
    const task = mockTask();
    const result = scoreDeterministic("HELLO WORLD", task);
    expect(result.score).toBe(10);
    expect(result.passed).toBe(true);
  });

  it("scores contains_all correctly", () => {
    const task = mockTask({
      grading: {
        type: "contains_all",
        expected: ["Answer: 58", "60"],
        maxScore: 10,
      },
      mock: {
        expectedOutput: "15 * 4 = 60\nAnswer: 58",
      },
    });
    const result = scoreDeterministic("The calculation: 15 * 4 = 60, so Answer: 58", task);
    expect(result.score).toBe(10);
    expect(result.passed).toBe(true);
  });

  it("scores json_structure correctly", () => {
    const task = mockTask({
      grading: {
        type: "json_structure",
        requiredKeys: ["name", "age", "city"],
        maxScore: 10,
      },
      mock: {
        expectedOutput: '{"name":"Alice","age":30,"city":"Toronto"}',
      },
    });

    const result = scoreDeterministic('{"name":"Alice","age":30,"city":"Toronto"}', task);
    expect(result.score).toBe(10);
    expect(result.passed).toBe(true);
  });

  it("handles JSON with markdown fences", () => {
    const task = mockTask({
      grading: {
        type: "json_structure",
        requiredKeys: ["name", "age"],
        maxScore: 10,
      },
      mock: {
        expectedOutput: '{"name":"Alice","age":30}',
      },
    });

    const result = scoreDeterministic('```json\n{"name":"Alice","age":30}\n```', task);
    expect(result.score).toBe(10);
    expect(result.passed).toBe(true);
  });

  it("scores missing JSON keys", () => {
    const task = mockTask({
      grading: {
        type: "json_structure",
        requiredKeys: ["name", "age", "city"],
        maxScore: 10,
      },
      mock: {
        expectedOutput: '{"name":"Alice","age":30,"city":"Toronto"}',
      },
    });

    const result = scoreDeterministic('{"name":"Alice"}', task);
    expect(result.percentage).toBeLessThan(100);
  });

  it("handles fuzzy matches", () => {
    const task = mockTask({
      grading: {
        type: "exact_match",
        expected: ["hello"],
        maxScore: 10,
      },
      mock: {
        expectedOutput: "hello world",
        fuzzyMatches: ["hello there"],
      },
    });

    const result = scoreDeterministic("hello there friend", task);
    expect(result.score).toBe(9);
    expect(result.passed).toBe(true);
  });

  it("handles task without mock data", () => {
    const task = mockTask({ mock: undefined });
    const result = scoreDeterministic("anything", task);
    expect(result.score).toBe(0);
    expect(result.details).toContain("No mock data");
  });
});

describe("buildJudgePrompt", () => {
  it("includes task info and model output", () => {
    const task = mockTask({
      grading: {
        type: "output_quality",
        criteria: ["Must be polite", "Must answer correctly"],
        maxScore: 10,
      },
    });

    const prompt = buildJudgePrompt(task, "Hello, the answer is 42.");
    expect(prompt).toContain("Test Task");
    expect(prompt).toContain("Hello, the answer is 42.");
    expect(prompt).toContain("Must be polite");
    expect(prompt).toContain("SCORE:");
  });
});

describe("parseJudgeResponse", () => {
  it("parses well-formatted response", () => {
    const result = parseJudgeResponse("SCORE: 8\nREASONING: Good answer with minor issues.", 10);
    expect(result.score).toBe(8);
    expect(result.maxScore).toBe(10);
    expect(result.percentage).toBe(80);
    expect(result.details).toContain("Good answer");
  });

  it("caps score at maxScore", () => {
    const result = parseJudgeResponse("SCORE: 15\nREASONING: Perfect.", 10);
    expect(result.score).toBe(10);
  });

  it("handles missing score", () => {
    const result = parseJudgeResponse("The answer was good but had some issues.", 10);
    expect(result.score).toBe(0);
  });

  it("handles decimal scores", () => {
    const result = parseJudgeResponse("SCORE: 7.5\nREASONING: Good.", 10);
    expect(result.score).toBe(7.5);
  });
});
