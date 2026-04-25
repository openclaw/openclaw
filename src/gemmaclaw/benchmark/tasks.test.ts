import { describe, expect, it } from "vitest";
import {
  BENCHMARK_TASKS,
  getMaxPossibleScore,
  getTasksByCategory,
  getTasksByDifficulty,
} from "./tasks.js";

describe("BENCHMARK_TASKS", () => {
  it("has at least 10 tasks", () => {
    expect(BENCHMARK_TASKS.length).toBeGreaterThanOrEqual(10);
  });

  it("all tasks have required fields", () => {
    for (const task of BENCHMARK_TASKS) {
      expect(task.id).toBeTruthy();
      expect(task.name).toBeTruthy();
      expect(task.category).toBeTruthy();
      expect(task.difficulty).toBeTruthy();
      expect(task.prompt).toBeTruthy();
      expect(task.grading.maxScore).toBeGreaterThan(0);
    }
  });

  it("all tasks have unique IDs", () => {
    const ids = BENCHMARK_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all tasks have mock data for deterministic mode", () => {
    for (const task of BENCHMARK_TASKS) {
      expect(task.mock).toBeDefined();
      expect(task.mock?.expectedOutput).toBeTruthy();
    }
  });

  it("covers all categories", () => {
    const categories = new Set(BENCHMARK_TASKS.map((t) => t.category));
    expect(categories).toContain("instruction_following");
    expect(categories).toContain("reasoning");
    expect(categories).toContain("extraction");
    expect(categories).toContain("safety");
    expect(categories).toContain("coding");
  });

  it("covers all difficulties", () => {
    const difficulties = new Set(BENCHMARK_TASKS.map((t) => t.difficulty));
    expect(difficulties).toContain("easy");
    expect(difficulties).toContain("medium");
    expect(difficulties).toContain("hard");
  });
});

describe("getTasksByCategory", () => {
  it("filters by category", () => {
    const coding = getTasksByCategory("coding");
    expect(coding.length).toBeGreaterThan(0);
    for (const task of coding) {
      expect(task.category).toBe("coding");
    }
  });
});

describe("getTasksByDifficulty", () => {
  it("filters by difficulty", () => {
    const easy = getTasksByDifficulty("easy");
    expect(easy.length).toBeGreaterThan(0);
    for (const task of easy) {
      expect(task.difficulty).toBe("easy");
    }
  });
});

describe("getMaxPossibleScore", () => {
  it("returns sum of all maxScores", () => {
    const expected = BENCHMARK_TASKS.reduce((sum, t) => sum + t.grading.maxScore, 0);
    expect(getMaxPossibleScore()).toBe(expected);
  });

  it("is greater than 100", () => {
    expect(getMaxPossibleScore()).toBeGreaterThan(100);
  });
});
