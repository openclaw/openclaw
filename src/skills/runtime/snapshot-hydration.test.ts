// Snapshot hydration tests cover restoring runtime skill state from saved snapshots.
import { describe, expect, it } from "vitest";
import type { SessionSkillSnapshot } from "../../config/sessions/types.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import { hydrateRuntimeSkillFields } from "./snapshot-hydration.js";

function makeFixtureSkill(name: string, bodySize = 3000) {
  const source = `# ${name}\n\n${"x".repeat(bodySize)}`;
  return createCanonicalFixtureSkill({
    name,
    description: `${name} skill description`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    source,
  });
}

describe("hydrateRuntimeSkillFields", () => {
  it("returns the same snapshot when both runtime fields are already populated", () => {
    const snapshot: SessionSkillSnapshot = {
      prompt: "p",
      skills: [{ name: "x" }],
      resolvedSkills: [makeFixtureSkill("x", 100)],
      resolvedSkillCommands: [],
      version: 1,
    };
    let buildCalls = 0;
    const result = hydrateRuntimeSkillFields(snapshot, () => {
      buildCalls += 1;
      return { prompt: "rebuilt", skills: [], resolvedSkills: [], version: 99 };
    });
    expect(result).toBe(snapshot);
    expect(buildCalls).toBe(0);
  });

  it("rebuilds runtime fields when missing and preserves persisted fields", () => {
    const stripped: SessionSkillSnapshot = {
      prompt: "original-prompt",
      skills: [{ name: "x" }],
      skillFilter: ["x"],
      version: 7,
    };
    const rebuiltSkills = [makeFixtureSkill("x", 200)];
    let buildCalls = 0;
    const rebuiltCommands = [
      {
        selectionPath: "/skills/x/SKILL.md",
        skillFile: "/skills/x/SKILL.md",
        skillName: "x",
        skillSource: "workspace" as const,
      },
    ];
    const result = hydrateRuntimeSkillFields(stripped, () => {
      buildCalls += 1;
      return {
        prompt: "DIFFERENT-PROMPT",
        skills: [{ name: "y" }],
        resolvedSkills: rebuiltSkills,
        resolvedSkillCommands: rebuiltCommands,
        version: 99,
      };
    });
    expect(buildCalls).toBe(1);
    expect(result.prompt).toBe("original-prompt");
    expect(result.skills).toEqual([{ name: "x" }]);
    expect(result.skillFilter).toEqual(["x"]);
    expect(result.version).toBe(7);
    expect(result.resolvedSkills).toBe(rebuiltSkills);
    expect(result.resolvedSkillCommands).toBe(rebuiltCommands);
  });

  it("hydrates only the missing runtime field", () => {
    const resolvedSkills = [makeFixtureSkill("x")];
    const snapshot: SessionSkillSnapshot = {
      prompt: "",
      skills: [],
      resolvedSkills,
      version: 1,
    };
    const rebuiltCommands = [
      {
        selectionPath: "/skills/x/SKILL.md",
        skillFile: "/skills/x/SKILL.md",
        skillName: "x",
        skillSource: "workspace" as const,
      },
    ];

    const result = hydrateRuntimeSkillFields(snapshot, () => ({
      resolvedSkills: [makeFixtureSkill("replacement")],
      resolvedSkillCommands: rebuiltCommands,
    }));

    expect(result.resolvedSkills).toBe(resolvedSkills);
    expect(result.resolvedSkillCommands).toBe(rebuiltCommands);
  });

  it("treats empty runtime arrays as populated", () => {
    const snapshot: SessionSkillSnapshot = {
      prompt: "",
      skills: [],
      resolvedSkills: [],
      resolvedSkillCommands: [],
      version: 1,
    };
    let buildCalls = 0;
    const result = hydrateRuntimeSkillFields(snapshot, () => {
      buildCalls += 1;
      return { prompt: "", skills: [], resolvedSkills: [makeFixtureSkill("x")], version: 1 };
    });
    expect(result).toBe(snapshot);
    expect(buildCalls).toBe(0);
  });
});
