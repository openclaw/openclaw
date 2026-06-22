// Prompt resolution tests cover skill prompt lookup and active skill selection.
import { describe, expect, it } from "vitest";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";
import { resolveSkillsPromptForRun, resolveSkillsPromptStateForRun } from "./workspace.js";

describe("resolveSkillsPromptForRun", () => {
  it("prefers snapshot prompt when available", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: { prompt: "SNAPSHOT", skills: [] },
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toBe("SNAPSHOT");
  });

  it("returns snapshot resolved skills with the snapshot prompt", () => {
    const skill = createCanonicalFixtureSkill({
      name: "snapshot-skill",
      description: "Snapshot",
      filePath: "/app/skills/snapshot-skill/SKILL.md",
      baseDir: "/app/skills/snapshot-skill",
      source: "openclaw-workspace",
    });

    const state = resolveSkillsPromptStateForRun({
      skillsSnapshot: {
        prompt: "SNAPSHOT",
        skills: [{ name: "snapshot-skill" }],
        resolvedSkills: [skill],
      },
      workspaceDir: "/tmp/openclaw",
    });

    expect(state.prompt).toBe("SNAPSHOT");
    expect(state.resolvedSkills).toStrictEqual([skill]);
  });

  it("builds prompt from entries when snapshot is missing", () => {
    const entry: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "demo-skill",
        description: "Demo",
        filePath: "/app/skills/demo-skill/SKILL.md",
        baseDir: "/app/skills/demo-skill",
        source: "openclaw-bundled",
      }),
      frontmatter: {},
    };
    const prompt = resolveSkillsPromptForRun({
      entries: [entry],
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("/app/skills/demo-skill/SKILL.md");
  });

  it("returns resolved skills from the same filtered entries used for the prompt", () => {
    const visible: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "visible-skill",
        description: "Visible",
        filePath: "/app/skills/visible-skill/SKILL.md",
        baseDir: "/app/skills/visible-skill",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    const hidden: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "hidden-skill",
        description: "Hidden",
        filePath: "/app/skills/hidden-skill/SKILL.md",
        baseDir: "/app/skills/hidden-skill",
        source: "openclaw-workspace",
        disableModelInvocation: true,
      }),
      frontmatter: {},
    };

    const state = resolveSkillsPromptStateForRun({
      skillsSnapshot: {
        prompt: " ",
        skills: [{ name: "stale-snapshot-skill" }],
        resolvedSkills: [
          createCanonicalFixtureSkill({
            name: "stale-snapshot-skill",
            description: "Stale",
            filePath: "/app/skills/stale-snapshot-skill/SKILL.md",
            baseDir: "/app/skills/stale-snapshot-skill",
            source: "openclaw-workspace",
          }),
        ],
      },
      entries: [visible, hidden],
      workspaceDir: "/tmp/openclaw",
    });

    expect(state.prompt).toContain("/app/skills/visible-skill/SKILL.md");
    expect(state.prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
    expect(state.resolvedSkills.map((skill) => skill.name)).toStrictEqual(["visible-skill"]);
  });

  it("keeps legacy entries with disableModelInvocation hidden when exposure metadata is absent", () => {
    const hidden: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "hidden-skill",
        description: "Hidden",
        filePath: "/app/skills/hidden-skill/SKILL.md",
        baseDir: "/app/skills/hidden-skill",
        source: "openclaw-workspace",
        disableModelInvocation: true,
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsPromptForRun({
      entries: [hidden],
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
  });

  it("inherits agents.defaults.skills when rebuilding prompt for an agent", () => {
    const visible: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "github",
        description: "GitHub",
        filePath: "/app/skills/github/SKILL.md",
        baseDir: "/app/skills/github",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    const hidden: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "hidden-skill",
        description: "Hidden",
        filePath: "/app/skills/hidden-skill/SKILL.md",
        baseDir: "/app/skills/hidden-skill",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsPromptForRun({
      entries: [visible, hidden],
      config: {
        agents: {
          defaults: {
            skills: ["github"],
          },
          list: [{ id: "writer" }],
        },
      },
      workspaceDir: "/tmp/openclaw",
      agentId: "writer",
    });

    expect(prompt).toContain("/app/skills/github/SKILL.md");
    expect(prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
  });

  it("returns resolved skills after applying the agent skill filter", () => {
    const visible: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "github",
        description: "GitHub",
        filePath: "/app/skills/github/SKILL.md",
        baseDir: "/app/skills/github",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    const hidden: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "hidden-skill",
        description: "Hidden",
        filePath: "/app/skills/hidden-skill/SKILL.md",
        baseDir: "/app/skills/hidden-skill",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };

    const state = resolveSkillsPromptStateForRun({
      entries: [visible, hidden],
      config: {
        agents: {
          defaults: {
            skills: ["github"],
          },
          list: [{ id: "writer" }],
        },
      },
      workspaceDir: "/tmp/openclaw",
      agentId: "writer",
    });

    expect(state.prompt).toContain("/app/skills/github/SKILL.md");
    expect(state.prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
    expect(state.resolvedSkills.map((skill) => skill.name)).toStrictEqual(["github"]);
  });

  it("uses agents.list[].skills as a full replacement for defaults", () => {
    const inheritedEntry: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "weather",
        description: "Weather",
        filePath: "/app/skills/weather/SKILL.md",
        baseDir: "/app/skills/weather",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    const explicitEntry: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "docs-search",
        description: "Docs",
        filePath: "/app/skills/docs-search/SKILL.md",
        baseDir: "/app/skills/docs-search",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsPromptForRun({
      entries: [inheritedEntry, explicitEntry],
      config: {
        agents: {
          defaults: {
            skills: ["weather"],
          },
          list: [{ id: "writer", skills: ["docs-search"] }],
        },
      },
      workspaceDir: "/tmp/openclaw",
      agentId: "writer",
    });

    expect(prompt).not.toContain("/app/skills/weather/SKILL.md");
    expect(prompt).toContain("/app/skills/docs-search/SKILL.md");
  });
});
