// Prompt resolution tests cover skill prompt lookup and active skill selection.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";
import { resolveSkillsPromptForRun } from "./workspace.js";

afterEach(() => {
  setActiveDegradedSecretOwners([]);
});

describe("resolveSkillsPromptForRun", () => {
  it("prefers snapshot prompt when available", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: { prompt: "SNAPSHOT", skills: [] },
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toBe("SNAPSHOT");
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

  it("rebuilds a snapshot-only legacy prompt without its unavailable skill", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-prompt-"));
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "cold-skill"),
      name: "cold-skill",
      description: "Cold",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "healthy-skill"),
      name: "healthy-skill",
      description: "Healthy",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "outside-skill"),
      name: "outside-skill",
      description: "Outside the saved filter",
    });
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "skill:cold-skill",
        state: "unavailable",
        paths: ["skills.entries.cold-skill.apiKey"],
        refKeys: ["env:default:MISSING_SKILL_KEY"],
        reason: "secret provider failed",
      },
    ]);

    try {
      const prompt = resolveSkillsPromptForRun({
        skillsSnapshot: {
          prompt: "STALE COLD SKILL PROMPT",
          skills: [{ name: "cold-skill" }, { name: "healthy-skill" }],
          skillFilter: ["cold-skill", "healthy-skill"],
        },
        config: {
          skills: {
            entries: {
              "cold-skill": {
                apiKey: { source: "env", provider: "default", id: "MISSING_SKILL_KEY" },
              },
            },
          },
        },
        workspaceDir,
      });

      expect(prompt).not.toContain("STALE COLD SKILL PROMPT");
      expect(prompt).not.toContain("cold-skill/SKILL.md");
      expect(prompt).toContain("healthy-skill/SKILL.md");
      expect(prompt).not.toContain("outside-skill/SKILL.md");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("matches unavailable owners against a snapshot skill's config key", () => {
    const cold: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "cold-skill",
        description: "Cold",
        filePath: "/app/skills/cold-skill/SKILL.md",
        baseDir: "/app/skills/cold-skill",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
      metadata: { skillKey: "cold-alias" },
    };
    const healthy: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "healthy-skill",
        description: "Healthy",
        filePath: "/app/skills/healthy-skill/SKILL.md",
        baseDir: "/app/skills/healthy-skill",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "skill:cold-alias",
        state: "unavailable",
        paths: ["skills.entries.cold-alias.apiKey"],
        refKeys: ["env:default:MISSING_SKILL_KEY"],
        reason: "secret provider failed",
      },
    ]);

    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: {
        prompt: "STALE COLD SKILL PROMPT",
        skills: [
          { name: "cold-skill", skillKey: "cold-alias" },
          { name: "healthy-skill", skillKey: "healthy-skill" },
        ],
      },
      entries: [cold, healthy],
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).not.toContain("STALE COLD SKILL PROMPT");
    expect(prompt).not.toContain("/app/skills/cold-skill/SKILL.md");
    expect(prompt).toContain("/app/skills/healthy-skill/SKILL.md");
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
