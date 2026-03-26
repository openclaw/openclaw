import { describe, expect, it } from "vitest";
import { filterSkillsForTaskProfile } from "./task-profile-skill-pack.js";

const makeSkill = (name: string, description: string) => ({
  name,
  description,
  filePath: `/skills/${name}/SKILL.md`,
  baseDir: `/skills/${name}`,
  source: "workspace" as const,
  disableModelInvocation: false,
});

describe("filterSkillsForTaskProfile", () => {
  it("drops weather-style skills from coding runs", () => {
    const filtered = filterSkillsForTaskProfile({
      taskProfile: "coding",
      skills: [
        makeSkill("weather", "Weather forecast lookup"),
        makeSkill("node-connect", "Connect to nodes and runtimes"),
      ],
    });
    expect(filtered.map((skill) => skill.name)).toEqual(["node-connect"]);
  });

  it("drops build and ops-flavored skills from research runs", () => {
    const filtered = filterSkillsForTaskProfile({
      taskProfile: "research",
      skills: [
        makeSkill("healthcheck", "Inspect runtime health"),
        makeSkill("skill-creator", "Create new skills"),
        makeSkill("clawhub", "Workspace knowledge hub"),
      ],
    });
    expect(filtered.map((skill) => skill.name)).toEqual(["clawhub"]);
  });

  it("preserves always skills even when they match deny patterns", () => {
    const filtered = filterSkillsForTaskProfile({
      taskProfile: "assistant",
      alwaysSkillNames: new Set(["healthcheck"]),
      skills: [
        makeSkill("healthcheck", "Inspect runtime health"),
        makeSkill("node-connect", "Connect to nodes and runtimes"),
      ],
    });
    expect(filtered.map((skill) => skill.name)).toEqual(["healthcheck"]);
  });

  it("falls back to the original skills when filtering would remove everything", () => {
    const filtered = filterSkillsForTaskProfile({
      taskProfile: "research",
      skills: [makeSkill("healthcheck", "Inspect runtime health")],
    });
    expect(filtered.map((skill) => skill.name)).toEqual(["healthcheck"]);
  });
});
