import { describe, expect, it } from "vitest";
import type { Skill } from "../loading/skill-contract.js";
import type { SkillEntry } from "../types.js";
import {
  buildMetaSkillCatalog,
  findDeterministicMetaTriggerMatch,
  findMetaPlanByName,
  findMetaTriggerMatches,
} from "./catalog.js";

function makeSkill(
  name: string,
  filePath: string,
  options: { disableModelInvocation?: boolean } = {},
): Skill {
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
    disableModelInvocation: options.disableModelInvocation ?? false,
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

function makeOrdinaryEntry(
  name: string,
  filePath: string,
  options: { disableModelInvocation?: boolean } = {},
): SkillEntry {
  return {
    skill: makeSkill(name, filePath, options),
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

  it("preserves risk metadata in projected meta plans", () => {
    const catalog = buildMetaSkillCatalog([
      makeMetaEntry("risk-aware", "/repo/src/skills/risk-aware/SKILL.md", {
        risk_metadata: '{"level":"medium","requiresApproval":true}',
      }),
    ]);

    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.plans[0]).toMatchObject({
      name: "risk-aware",
      riskMetadata: {
        level: "medium",
        requiresApproval: true,
      },
    });
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

  it("rejects tool_call steps outside the available tool allowlist", () => {
    const entries = [
      makeMetaEntry("tool-meta", "/repo/src/skills/tool-meta/SKILL.md", {
        composition: '{"steps":[{"id":"publish","kind":"tool_call","tool":"notify"}]}',
        final_text_mode: "auto",
      }),
    ];

    expect(
      buildMetaSkillCatalog(entries, {
        availableToolNames: ["notify"],
      }).diagnostics,
    ).toEqual([]);

    const unavailable = buildMetaSkillCatalog(entries, {
      availableToolNames: ["read"],
    });
    expect(unavailable.plans).toEqual([]);
    expect(unavailable.diagnostics[0]).toMatchObject({
      skillName: "tool-meta",
      message: "step publish tool_call references unavailable tool notify",
    });
  });

  it("rejects blocked meta wrapper tool_call targets before runtime", () => {
    const catalog = buildMetaSkillCatalog([
      makeMetaEntry("recursive-meta", "/repo/src/skills/recursive-meta/SKILL.md", {
        composition: '{"steps":[{"id":"recurse","kind":"tool_call","tool":"meta_invoke"}]}',
        final_text_mode: "auto",
      }),
    ]);

    expect(catalog.plans).toEqual([]);
    expect(catalog.diagnostics[0]).toMatchObject({
      skillName: "recursive-meta",
      message: "step recurse tool_call target meta_invoke is not allowed",
    });
  });

  it("validates skill_exec targets against loaded ordinary skills", () => {
    const metaEntry = makeMetaEntry("delegate-meta", "/repo/src/skills/delegate-meta/SKILL.md", {
      composition: '{"steps":[{"id":"delegate","kind":"skill_exec","skill":"helper"}]}',
      final_text_mode: "auto",
    });

    const valid = buildMetaSkillCatalog([
      metaEntry,
      makeOrdinaryEntry("helper", "/repo/src/skills/helper/SKILL.md"),
    ]);
    expect(valid.diagnostics).toEqual([]);
    expect(valid.plans).toHaveLength(1);

    const missing = buildMetaSkillCatalog([metaEntry]);
    expect(missing.plans).toEqual([]);
    expect(missing.diagnostics[0]).toMatchObject({
      skillName: "delegate-meta",
      message: "step delegate skill_exec references unavailable skill helper",
    });

    const metaTarget = buildMetaSkillCatalog([
      metaEntry,
      makeMetaEntry("helper", "/repo/src/skills/helper/SKILL.md"),
    ]);
    expect(metaTarget.plans.map((plan) => plan.name)).toEqual(["helper"]);
    expect(metaTarget.diagnostics).toEqual([
      expect.objectContaining({
        skillName: "delegate-meta",
        message: "step delegate skill_exec target helper must be an ordinary skill",
      }),
    ]);

    const disabled = buildMetaSkillCatalog([
      metaEntry,
      makeOrdinaryEntry("helper", "/repo/src/skills/helper/SKILL.md", {
        disableModelInvocation: true,
      }),
    ]);
    expect(disabled.plans).toEqual([]);
    expect(disabled.diagnostics[0]).toMatchObject({
      skillName: "delegate-meta",
      message: "step delegate skill_exec target helper disables model invocation",
    });
  });
});

describe("meta trigger matching", () => {
  it("finds exact natural-language and slash-prefix deterministic triggers", () => {
    const catalog = buildMetaSkillCatalog([
      makeMetaEntry("creator", "/repo/src/skills/creator/SKILL.md", {
        triggers: '["create a skill", "/skill"]',
      }),
    ]);

    expect(findDeterministicMetaTriggerMatch(catalog, "  Create   A Skill  ")).toMatchObject({
      kind: "deterministic",
      plan: expect.objectContaining({ name: "creator" }),
      trigger: "create a skill",
    });
    expect(findDeterministicMetaTriggerMatch(catalog, "/skill summarize workflow")).toMatchObject({
      kind: "deterministic",
      plan: expect.objectContaining({ name: "creator" }),
      trigger: "/skill",
    });
  });

  it("keeps contained phrase matches soft unless they are exact", () => {
    const catalog = buildMetaSkillCatalog([
      makeMetaEntry("creator", "/repo/src/skills/creator/SKILL.md", {
        triggers: '["create a skill"]',
      }),
    ]);

    expect(
      findDeterministicMetaTriggerMatch(catalog, "please create a skill for this"),
    ).toBeUndefined();
    expect(findMetaTriggerMatches(catalog, "please create a skill for this")).toEqual([
      {
        kind: "soft",
        plan: catalog.plans[0],
        trigger: "create a skill",
      },
    ]);
  });

  it("does not return a deterministic match when triggers are ambiguous", () => {
    const catalog = buildMetaSkillCatalog([
      makeMetaEntry("first", "/repo/src/skills/first/SKILL.md", {
        triggers: '["/skill"]',
      }),
      makeMetaEntry("second", "/repo/src/skills/second/SKILL.md", {
        triggers: '["/skill"]',
      }),
    ]);

    expect(findDeterministicMetaTriggerMatch(catalog, "/skill draft")).toBeUndefined();
    expect(findMetaTriggerMatches(catalog, "/skill draft")).toHaveLength(2);
  });
});
