import { describe, expect, it } from "vitest";
import type { Skill } from "../loading/skill-contract.js";
import type { SkillEntry } from "../types.js";
import { buildMetaSkillCatalog, findMetaPlanByName } from "./catalog.js";

function makeSkill(name: string, filePath: string): Skill {
  return {
    name,
    description: `${name} description`,
    filePath,
    baseDir: filePath.replace(/\/SKILL\.md$/, ""),
    sourceInfo: {
      path: filePath,
      source: "workspace",
      scope: "project",
      origin: "top-level",
      baseDir: filePath.replace(/\/SKILL\.md$/, ""),
    },
    disableModelInvocation: false,
    source: `# ${name}`,
  };
}

function makeMetaEntry(
  name: string,
  filePath: string,
  frontmatterOverrides: Partial<SkillEntry["frontmatter"]> = {},
): SkillEntry {
  return {
    skill: makeSkill(name, filePath),
    frontmatter: {
      name,
      description: `${name} description`,
      kind: "meta",
      triggers: '["trigger"]',
      composition:
        '{"steps":[{"id":"draft","kind":"llm_chat","prompt":"Draft"},{"id":"final","kind":"llm_chat","depends_on":["draft"],"prompt":"Finalize"}]}',
      final_text_mode: "step:final",
      ...frontmatterOverrides,
    },
  };
}

function makeOrdinaryEntry(name: string, filePath: string): SkillEntry {
  return {
    skill: makeSkill(name, filePath),
    frontmatter: {
      name,
      description: `${name} description`,
      kind: "ordinary",
    },
  };
}

describe("buildMetaSkillCatalog", () => {
  it("projects valid meta skills into plans and preserves source file paths", () => {
    const entries = [makeMetaEntry("meta-demo", "/repo/src/skills/meta-demo/SKILL.md")];

    const catalog = buildMetaSkillCatalog(entries);

    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.plans).toHaveLength(1);
    expect(catalog.plans[0]).toMatchObject({
      name: "meta-demo",
      description: "meta-demo description",
      triggers: [{ pattern: "trigger" }],
      sourceFilePath: "/repo/src/skills/meta-demo/SKILL.md",
      finalTextMode: { kind: "step", stepId: "final" },
    });
    expect(catalog.plans[0].steps.map((step) => step.id)).toEqual(["draft", "final"]);
    expect(findMetaPlanByName(catalog, "meta-demo")).toBe(catalog.plans[0]);
    expect(findMetaPlanByName(catalog, "missing")).toBeUndefined();
  });

  it("ignores ordinary skills", () => {
    const entries = [
      makeOrdinaryEntry("ordinary-skill", "/repo/src/skills/ordinary-skill/SKILL.md"),
    ];

    expect(buildMetaSkillCatalog(entries)).toEqual({
      plans: [],
      diagnostics: [],
    });
  });

  it("returns diagnostics for invalid meta skills instead of throwing", () => {
    const entries = [
      makeMetaEntry("broken-meta", "/repo/src/skills/broken-meta/SKILL.md", {
        triggers: '["trigger"]',
        composition: '{"steps":[{"id":"bad","kind":"shell_script","prompt":"nope"}]}',
      }),
    ];

    const catalog = buildMetaSkillCatalog(entries);

    expect(catalog.plans).toEqual([]);
    expect(catalog.diagnostics).toHaveLength(1);
    expect(catalog.diagnostics[0]).toMatchObject({
      skillName: "broken-meta",
      filePath: "/repo/src/skills/broken-meta/SKILL.md",
    });
    expect(catalog.diagnostics[0].message).toContain("Unsupported meta step kind");
  });

  it("sorts plans and diagnostics deterministically by skill name", () => {
    const entries = [
      makeMetaEntry("zeta-plan", "/repo/src/skills/zeta-plan/SKILL.md"),
      makeMetaEntry("beta-broken", "/repo/src/skills/beta-broken/SKILL.md", {
        composition: '{"steps":[{"id":"bad","kind":"shell_script","prompt":"nope"}]}',
      }),
      makeMetaEntry("alpha-plan", "/repo/src/skills/alpha-plan/SKILL.md"),
      makeMetaEntry("gamma-broken", "/repo/src/skills/gamma-broken/SKILL.md", {
        composition: '{"steps":[{"id":"bad","kind":"shell_script","prompt":"nope"}]}',
      }),
    ];

    const catalog = buildMetaSkillCatalog(entries);

    expect(catalog.plans.map((plan) => plan.name)).toEqual(["alpha-plan", "zeta-plan"]);
    expect(catalog.diagnostics.map((diagnostic) => diagnostic.skillName)).toEqual([
      "beta-broken",
      "gamma-broken",
    ]);
  });
});
