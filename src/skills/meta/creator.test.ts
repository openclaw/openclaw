import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../loading/frontmatter.js";
import type { Skill } from "../loading/skill-contract.js";
import type { SkillEntry } from "../types.js";
import { buildMetaSkillCatalog } from "./catalog.js";

function skillEntryFromFile(filePath: string, source: string): SkillEntry {
  const name = path.basename(path.dirname(filePath));
  const skill: Skill = {
    name,
    description: `${name} description`,
    filePath,
    baseDir: path.dirname(filePath),
    source,
    sourceInfo: {
      path: filePath,
      source: "openclaw-bundled",
      scope: "project",
      origin: "top-level",
      baseDir: path.dirname(filePath),
    },
    disableModelInvocation: false,
  };
  return {
    skill,
    frontmatter: parseFrontmatter(source),
  };
}

describe("meta-skill-creator bundled skill", () => {
  it("keeps the shipped meta-skill creator parseable and wired to Skill Workshop", async () => {
    const skillFile = path.resolve("skills/meta-skill-creator/SKILL.md");
    const source = await fs.readFile(skillFile, "utf8");

    const catalog = buildMetaSkillCatalog([skillEntryFromFile(skillFile, source)]);

    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.plans).toHaveLength(1);
    const plan = catalog.plans[0];
    expect(plan).toMatchObject({
      name: "meta-skill-creator",
      finalTextMode: { kind: "step", stepId: "proposal" },
    });
    const proposalStep = plan.steps.find((step) => step.id === "proposal");
    expect(proposalStep).toMatchObject({
      kind: "tool_call",
      toolName: "skill_workshop",
      args: {
        action: "create",
        name: "{{collect.name}}",
        description: "{{collect.description}}",
        proposal_content: "{{collect.content}}",
        goal: "Created by meta-skill-creator",
        evidence: "creator workflow collected: {{collect.workflow}}",
      },
    });
    expect(proposalStep?.args).not.toHaveProperty("content");
  });
});
