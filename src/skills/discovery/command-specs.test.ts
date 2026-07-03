// Command spec tests cover skill-provided command metadata and filtering.
import { describe, expect, it, vi } from "vitest";
import { createFixtureSkillEntry } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";
import { buildWorkspaceSkillCommandSpecs } from "./command-specs.js";

vi.mock("../../plugins/bundle-commands.js", () => ({
  loadEnabledClaudeBundleCommands: () => [],
}));

vi.mock("../loading/workspace.js", () => ({
  filterWorkspaceSkillEntriesWithOptions: (entries: SkillEntry[]) => entries,
  loadVisibleWorkspaceSkillEntries: () => [],
}));

describe("buildWorkspaceSkillCommandSpecs", () => {
  it("uses shared user-invocable skill exposure policy", () => {
    const specs = buildWorkspaceSkillCommandSpecs("/workspace", {
      entries: [
        createFixtureSkillEntry("visible"),
        createFixtureSkillEntry("hidden-by-exposure", {
          exposure: {
            includeInRuntimeRegistry: true,
            includeInAvailableSkillsPrompt: true,
            userInvocable: false,
          },
        }),
        createFixtureSkillEntry("hidden-by-invocation", {
          invocation: {
            userInvocable: false,
            disableModelInvocation: false,
          },
        }),
      ],
    });

    expect(specs.map((spec) => spec.skillName)).toEqual(["visible"]);
  });

  it("truncates workspace skill descriptions without splitting surrogate pairs", () => {
    // 99 ASCII chars + 😀 (2 UTF-16 code units) → raw slice at 99 would
    // split the surrogate pair, producing a dangling high surrogate + "…".
    const prefix = "a".repeat(98);
    const name = "emoji-skill";
    const entry: SkillEntry = {
      skill: {
        name,
        description: `${prefix}😀 extra text beyond the limit`,
        filePath: `/skills/${name}/SKILL.md`,
        baseDir: `/skills/${name}`,
        source: "openclaw-workspace",
      },
      frontmatter: {},
      invocation: { userInvocable: true, disableModelInvocation: false },
    };
    const specs = buildWorkspaceSkillCommandSpecs("/workspace", {
      entries: [entry],
    });
    expect(specs).toHaveLength(1);
    const desc = specs[0]!.description;
    // No replacement character from a split surrogate pair
    expect(desc).not.toContain("�");
    // Truncation marker present (description exceeded the limit)
    expect(desc).toContain("…");
  });

  it("truncates bundle command descriptions without splitting surrogate pairs", () => {
    const prefix = "a".repeat(98);
    const name = "bundle-emoji";
    const entry: SkillEntry = {
      skill: {
        name,
        description: `${prefix}😀 extra text beyond the limit`,
        filePath: `/skills/${name}/SKILL.md`,
        baseDir: `/skills/${name}`,
        source: "openclaw-workspace",
      },
      frontmatter: {},
      invocation: { userInvocable: true, disableModelInvocation: false },
    };
    const specs = buildWorkspaceSkillCommandSpecs("/workspace", {
      entries: [entry],
    });
    expect(specs).toHaveLength(1);
    const desc = specs[0]!.description;
    expect(desc).not.toContain("�");
    expect(desc).toContain("…");
  });
});
