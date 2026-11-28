// Skill filter tests cover allowlist and agent-scoped skill selection behavior.
import { describe, expect, it } from "vitest";
import { isSessionSkillEnabled } from "./agent-filter.js";
import { matchesSkillFilter, normalizeSkillFilter } from "./filter.js";

const sessionSkillCases: Array<{
  name: string;
  skill: string;
  skillKey?: string;
  base: string[];
  overrides?: Record<string, boolean>;
  expected: boolean;
}> = [
  {
    name: "enables a skill outside the agent allowlist",
    skill: "release",
    base: ["github"],
    overrides: { release: true },
    expected: true,
  },
  {
    name: "disables a skill inside the agent allowlist",
    skill: "github",
    base: ["github"],
    overrides: { github: false },
    expected: false,
  },
  {
    name: "inherits the resolved agent filter when absent",
    skill: "github",
    base: ["github"],
    expected: true,
  },
  {
    name: "applies canonical skill-key overrides without changing name-based agent filters",
    skill: "friendly-skill-name",
    skillKey: "canonical-skill-key",
    base: ["friendly-skill-name"],
    overrides: { "canonical-skill-key": false },
    expected: false,
  },
];

describe("skills/filter", () => {
  it("normalizes configured filters with trimming", () => {
    expect(normalizeSkillFilter([" weather ", "", "meme-factory", " weather "])).toEqual([
      "weather",
      "meme-factory",
      "weather",
    ]);
  });

  it("preserves explicit empty list as []", () => {
    expect(normalizeSkillFilter([])).toStrictEqual([]);
    expect(normalizeSkillFilter(undefined)).toBeUndefined();
  });

  it.each([
    {
      name: "reordered duplicates",
      cached: ["weather", "meme-factory"],
      next: [" meme-factory ", "weather", "weather"],
      expected: true,
    },
    { name: "both absent", cached: undefined, next: undefined, expected: true },
    { name: "both empty", cached: [], next: [], expected: true },
    { name: "empty versus absent", cached: [], next: undefined, expected: false },
    { name: "absent versus empty", cached: undefined, next: [], expected: false },
    { name: "blank entries", cached: ["", "   "], next: [], expected: true },
    {
      name: "different membership",
      cached: ["weather", "meme-factory"],
      next: ["weather", "other"],
      expected: false,
    },
    { name: "case-sensitive names", cached: ["Weather"], next: ["weather"], expected: false },
    {
      name: "string coercion",
      cached: [42, null, false],
      next: [" 42 ", "null", "false"],
      expected: true,
    },
  ])("compares $name", ({ cached, next, expected }) => {
    expect(matchesSkillFilter(cached, next)).toBe(expected);
  });

  it("normalizes both inputs in order even when they share an array", () => {
    const values = ["weather", "other"];
    const entry = { toString: () => values.shift() ?? "" };
    const filter = Object.freeze([entry]);
    expect(matchesSkillFilter(filter, filter)).toBe(false);
    expect(values).toEqual([]);
  });

  it.each(sessionSkillCases)("$name", ({ skill, skillKey, base, overrides, expected }) => {
    expect(isSessionSkillEnabled(skill, base, overrides, skillKey)).toBe(expected);
  });
});
