// Compact skill path tests cover short path formatting for skill prompt payloads.
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import { testing as workspaceSkillsTesting, buildWorkspaceSkillsPrompt } from "./workspace.js";

describe("compactSkillPaths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function buildPromptForFixtureSkill(params: {
    workspaceRoot: string;
    skillDir: string;
    name: string;
    description: string;
  }) {
    return buildWorkspaceSkillsPrompt(params.workspaceRoot, {
      entries: [
        {
          skill: createCanonicalFixtureSkill({
            name: params.name,
            description: params.description,
            filePath: path.join(params.skillDir, "SKILL.md"),
            baseDir: params.skillDir,
            source: "test",
          }),
          frontmatter: {},
          metadata: undefined,
          invocation: { disableModelInvocation: false, userInvocable: true },
          exposure: {
            includeInRuntimeRegistry: true,
            includeInAvailableSkillsPrompt: true,
            userInvocable: true,
          },
        },
      ],
    });
  }

  it("replaces home directory prefix with ~ in skill locations", () => {
    const home = os.homedir();
    const skillDir = path.join(home, ".openclaw-test-skills", "test-skill");

    const prompt = buildPromptForFixtureSkill({
      workspaceRoot: home,
      skillDir,
      name: "test-skill",
      description: "A test skill for path compaction",
    });

    expect(prompt).not.toContain(home + path.sep);
    expect(prompt).toContain("~/");
    expect(prompt).toContain("test-skill");
    expect(prompt).toContain("A test skill for path compaction");
  });

  it("does not compact explicit state-root managed skill paths to OS-home tilde paths", () => {
    const root = path.parse(os.homedir()).root;
    const osHome = path.join(root, "data");
    const stateDir = path.join(osHome, ".openclaw");
    const skillDir = path.join(stateDir, "skills", "world-cup-soccer-openclaw-skill");
    const skillFile = path.join(skillDir, "SKILL.md");

    vi.stubEnv("HOME", osHome);
    vi.stubEnv("OPENCLAW_HOME", osHome);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));

    const prompt = buildPromptForFixtureSkill({
      workspaceRoot: path.join(root, "workspace"),
      skillDir,
      name: "world-cup-soccer-openclaw-skill",
      description: "World Cup standings lookup",
    });

    expect(prompt).toContain(`<location>${skillFile}</location>`);
    expect(prompt).not.toContain("~/.openclaw/skills/world-cup-soccer-openclaw-skill/SKILL.md");
  });

  it("does not compact explicit state-root plugin skill paths to OS-home tilde paths", () => {
    const root = path.parse(os.homedir()).root;
    const osHome = path.join(root, "data");
    const stateDir = path.join(osHome, ".openclaw");
    const skillDir = path.join(stateDir, "plugin-skills", "calendar-plugin-skill");
    const skillFile = path.join(skillDir, "SKILL.md");

    vi.stubEnv("HOME", osHome);
    vi.stubEnv("OPENCLAW_HOME", osHome);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));

    const prompt = buildPromptForFixtureSkill({
      workspaceRoot: path.join(root, "workspace"),
      skillDir,
      name: "calendar-plugin-skill",
      description: "Calendar plugin skill",
    });

    expect(prompt).toContain(`<location>${skillFile}</location>`);
    expect(prompt).not.toContain("~/.openclaw/plugin-skills/calendar-plugin-skill/SKILL.md");
  });

  it("compacts managed skill paths when OS-home tilde reaches the same path", () => {
    const home = os.homedir();
    const stateDir = path.join(home, ".openclaw");
    const skillDir = path.join(stateDir, "skills", "home-managed-skill");

    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_HOME", undefined);

    const prompt = buildPromptForFixtureSkill({
      workspaceRoot: path.join(home, "workspace"),
      skillDir,
      name: "home-managed-skill",
      description: "Home managed skill",
    });

    expect(prompt).toContain("<location>~/.openclaw/skills/home-managed-skill/SKILL.md</location>");
    expect(prompt).not.toContain(`<location>${path.join(skillDir, "SKILL.md")}</location>`);
  });

  it("normalizes compacted Windows skill locations to forward slashes", () => {
    const home = "C:\\Users\\alice";
    const skillPath = path.win32.join(home, ".openclaw-test-skills", "win-skill", "SKILL.md");

    const compactedPath = workspaceSkillsTesting.compactHomePath(skillPath, [home]);

    expect(compactedPath).toBe("~/.openclaw-test-skills/win-skill/SKILL.md");
  });

  it("preserves POSIX literal backslashes after home compaction", () => {
    const home = os.homedir();
    const skillDir = path.join(home, ".openclaw-test-skills\\literal-skill");

    const prompt = buildPromptForFixtureSkill({
      workspaceRoot: home,
      skillDir,
      name: "literal-skill",
      description: "POSIX literal backslash skill",
    });

    const locationMatch = prompt.match(/<location>([^<]+)<\/location>/);
    if (!locationMatch) {
      throw new Error("expected prompt location tag");
    }
    expect(locationMatch[1]).toContain("~/");
    expect(locationMatch[1]).toContain("\\literal-skill");
  });

  it("preserves paths outside home directory", () => {
    const outsideHome = path.join(path.parse(os.homedir()).root, "openclaw-external-skills");
    const skillDir = path.join(outsideHome, "skills", "ext-skill");

    const prompt = buildPromptForFixtureSkill({
      workspaceRoot: outsideHome,
      skillDir,
      name: "ext-skill",
      description: "External skill",
    });

    expect(prompt).toMatch(/<location>[^<]+SKILL\.md<\/location>/);
    expect(prompt).toContain(path.join(skillDir, "SKILL.md"));
  });
});
