import { describe, expect, it, vi } from "vitest";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
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
        createEntry("visible"),
        createEntry("hidden-by-exposure", {
          exposure: {
            includeInRuntimeRegistry: true,
            includeInAvailableSkillsPrompt: true,
            userInvocable: false,
          },
        }),
        createEntry("hidden-by-invocation", {
          invocation: {
            userInvocable: false,
            disableModelInvocation: false,
          },
        }),
      ],
    });

    expect(specs.map((spec) => spec.skillName)).toEqual(["visible"]);
  });
});

function createEntry(
  name: string,
  opts?: {
    exposure?: SkillEntry["exposure"];
    invocation?: SkillEntry["invocation"];
  },
): SkillEntry {
  return {
    skill: createCanonicalFixtureSkill({
      name,
      description: `${name} description`,
      filePath: `/skills/${name}/SKILL.md`,
      baseDir: `/skills/${name}`,
      source: "openclaw-workspace",
    }),
    frontmatter: {},
    invocation: opts?.invocation ?? {
      userInvocable: true,
      disableModelInvocation: false,
    },
    exposure: opts?.exposure,
  };
}
