import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "../openclaw-tools.js";
import { createCanonicalFixtureSkill } from "../skills.test-helpers.js";
import type { Skill } from "../skills/skill-contract.js";
import type { SkillSnapshot } from "../skills/types.js";
import { createSkillRouteTool, rankSkillRoutes } from "./skill-route-tool.js";

function skill(name: string, description: string): Skill {
  return createCanonicalFixtureSkill({
    name,
    description,
    filePath: `/tmp/skills/${name}/SKILL.md`,
    baseDir: `/tmp/skills/${name}`,
    source: "test",
  });
}

function snapshot(skills: Skill[]): SkillSnapshot {
  return {
    prompt: "",
    skills: skills.map((entry) => ({ name: entry.name })),
    resolvedSkills: skills,
  };
}

function detailsOf(
  result: Awaited<ReturnType<NonNullable<ReturnType<typeof createSkillRouteTool>>["execute"]>>,
) {
  return result.details as {
    status: string;
    instruction: string;
    matches: Array<{ name: string; score: number; location?: string }>;
  };
}

describe("local_skill_route", () => {
  it("ranks the skill that matches the user task", () => {
    const matches = rankSkillRoutes({
      query: "please schedule a calendar meeting tomorrow",
      skills: [
        skill("github", "Review pull requests and issues"),
        skill("calendar", "Create and update calendar events and meetings"),
      ],
    });

    expect(matches[0]).toMatchObject({
      name: "calendar",
      location: "/tmp/skills/calendar/SKILL.md",
    });
    expect(matches[0]?.score).toBeGreaterThan(matches[1]?.score ?? 0);
  });

  it("returns a matched instruction with the SKILL.md location", async () => {
    const tool = createSkillRouteTool({
      skillsSnapshot: snapshot([
        skill("github", "Review pull requests and issues"),
        skill("calendar", "Create and update calendar events and meetings"),
      ]),
    });

    expect(tool).not.toBeNull();
    const result = await tool!.execute("route", {
      query: "create a calendar event",
    });
    const details = detailsOf(result);

    expect(details.status).toBe("matched");
    expect(details.matches[0]).toMatchObject({
      name: "calendar",
      location: "/tmp/skills/calendar/SKILL.md",
    });
    expect(details.instruction).toContain("/tmp/skills/calendar/SKILL.md");
  });

  it("marks close matches as ambiguous", async () => {
    const tool = createSkillRouteTool({
      skillsSnapshot: snapshot([
        skill("github-pr", "Review GitHub pull requests"),
        skill("github-issues", "Triage GitHub issues"),
      ]),
    });

    const result = await tool!.execute("route", {
      query: "github",
    });
    const details = detailsOf(result);

    expect(details.status).toBe("ambiguous");
    expect(details.matches.map((match) => match.name).toSorted()).toEqual([
      "github-issues",
      "github-pr",
    ]);
  });

  it("does not recommend a skill for unrelated requests", async () => {
    const tool = createSkillRouteTool({
      skillsSnapshot: snapshot([skill("calendar", "Create and update calendar events")]),
    });

    const result = await tool!.execute("route", {
      query: "resize this image and remove the background",
    });
    const details = detailsOf(result);

    expect(details.status).toBe("nomatch");
    expect(details.instruction).toContain("Do not read a skill");
  });

  it("is registered only when skills are available", () => {
    const withoutSkills = createOpenClawTools({ disablePluginTools: true });
    expect(withoutSkills.some((tool) => tool.name === "local_skill_route")).toBe(false);

    const withSkills = createOpenClawTools({
      disablePluginTools: true,
      skillsSnapshot: snapshot([skill("calendar", "Create and update calendar events")]),
    });
    expect(withSkills.some((tool) => tool.name === "local_skill_route")).toBe(true);
  });
});
