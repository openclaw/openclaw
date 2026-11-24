import { describe, expect, it } from "vitest";
import type { Skill } from "./skill-contract.js";
import { prepareSkillsForPrompt } from "./skill-prompt-limits.js";

function makeSkill(name: string, description: string): Skill {
  const baseDir = `/virtual/${name}`;
  const filePath = `${baseDir}/SKILL.md`;
  return {
    name,
    description,
    filePath,
    baseDir,
    source: "test",
    sourceInfo: { path: filePath, source: "test", scope: "temporary", origin: "top-level" },
    disableModelInvocation: false,
  };
}

/** Skills whose catalog is wide enough that names alone overflow the budget. */
function makeCatalog(count: number, descriptionLength = 240): Skill[] {
  return Array.from({ length: count }, (_, index) =>
    makeSkill(`skill-${String(index).padStart(3, "0")}`, "D".repeat(descriptionLength)),
  );
}

describe("prepareSkillsForPrompt budget reporting", () => {
  it("reports a full catalog with no omissions", () => {
    const skills = makeCatalog(3, 40);
    const prepared = prepareSkillsForPrompt({ skills, maxSkillsPromptChars: 18_000 });

    expect(prepared.budget).toMatchObject({
      total: 3,
      admitted: 3,
      omitted: [],
      format: "full",
      descriptionsOmitted: false,
    });
  });

  it("names the skills dropped by the prompt budget", () => {
    const skills = makeCatalog(40);
    const prepared = prepareSkillsForPrompt({ skills, maxSkillsPromptChars: 2_000 });

    expect(prepared.budget.admitted).toBeLessThan(prepared.budget.total);
    expect(prepared.budget.omitted).toHaveLength(prepared.budget.total - prepared.budget.admitted);
    expect(prepared.budget.omitted).toContain("skill-039");
    expect(prepared.prompt).toContain(
      `Skills truncated: included ${prepared.budget.admitted} of ${prepared.budget.total}`,
    );
  });

  it("flags a catalog that lost every description", () => {
    const skills = makeCatalog(40);
    const prepared = prepareSkillsForPrompt({ skills, maxSkillsPromptChars: 2_000 });

    expect(prepared.budget.descriptionsOmitted).toBe(true);
    expect(prepared.budget.descriptionMaxChars).toBe(0);
    expect(prepared.prompt).not.toContain("<description>");
  });
});

describe("prepareSkillsForPrompt description floor", () => {
  it("keeps descriptions and admits fewer skills when a floor is configured", () => {
    const skills = makeCatalog(40);
    const withoutFloor = prepareSkillsForPrompt({ skills, maxSkillsPromptChars: 4_000 });
    const withFloor = prepareSkillsForPrompt({
      skills,
      maxSkillsPromptChars: 4_000,
      minDescriptionChars: 40,
    });

    expect(withoutFloor.budget.descriptionsOmitted).toBe(true);
    expect(withFloor.budget.descriptionsOmitted).toBe(false);
    expect(withFloor.budget.descriptionMaxChars).toBeGreaterThanOrEqual(40);
    expect(withFloor.budget.admitted).toBeLessThan(withoutFloor.budget.admitted);
    expect(withFloor.prompt).toContain("<description>");
  });

  it("keeps the current name-only catalog when no floor is configured", () => {
    const skills = makeCatalog(40);
    const prepared = prepareSkillsForPrompt({ skills, maxSkillsPromptChars: 2_000 });

    // Legacy behavior: the catalog is sized for names, so descriptions are dropped.
    expect(prepared.budget.descriptionsOmitted).toBe(true);
    expect(prepared.budget.admitted).toBe(15);
    expect(prepared.prompt).not.toContain("<description>");
  });

  it("never returns an empty catalog just to keep descriptions", () => {
    const skills = makeCatalog(40);
    const prepared = prepareSkillsForPrompt({
      skills,
      maxSkillsPromptChars: 1_000,
      minDescriptionChars: 220,
    });

    // A budget that fits name-only entries still admits at least one skill.
    expect(prepared.budget.admitted).toBeGreaterThan(0);
    expect(prepared.prompt).not.toBe("");
    expect(prepared.budget.descriptionsOmitted).toBe(false);
  });
});
