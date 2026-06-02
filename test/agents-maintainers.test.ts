import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe(".agents/maintainers.md", () => {
  const maintainersPath = path.join(repoRoot, ".agents", "maintainers.md");

  it("exists after the skills cleanup PR", () => {
    expect(existsSync(maintainersPath)).toBe(true);
  });

  it("contains a redirect notice pointing to the openclaw/maintainers repo", () => {
    const content = readFileSync(maintainersPath, "utf8");
    expect(content).toContain("openclaw/maintainers");
  });

  it("references the correct GitHub repository URL", () => {
    const content = readFileSync(maintainersPath, "utf8");
    expect(content).toContain("https://github.com/openclaw/maintainers/");
  });

  it("is non-empty", () => {
    const content = readFileSync(maintainersPath, "utf8").trim();
    expect(content.length).toBeGreaterThan(0);
  });
});

describe(".agents/skills cleanup – removed skills no longer present", () => {
  const removedSkills = [
    "agent-transcript",
    "autoreview",
    "channel-message-flows",
    "clawdtributor",
    "clawsweeper",
    "control-ui-e2e",
    "crabbox",
    "discord-clawd",
    "discrawl",
    "gitcrawl",
    "graincrawl",
    "notcrawl",
  ];

  for (const skill of removedSkills) {
    it(`does not contain the removed skill: ${skill}`, () => {
      const skillPath = path.join(repoRoot, ".agents", "skills", skill);
      expect(existsSync(skillPath)).toBe(false);
    });
  }

  it("does not contain the removed telegram maintainer notes", () => {
    const telegramNotesPath = path.join(repoRoot, ".agents", "maintainer-notes", "telegram.md");
    expect(existsSync(telegramNotesPath)).toBe(false);
  });

  it("does not contain the removed maintainer-notes directory", () => {
    const notesDir = path.join(repoRoot, ".agents", "maintainer-notes");
    expect(existsSync(notesDir)).toBe(false);
  });
});

describe(".agents/skills remaining structure", () => {
  it("still contains the openclaw-test-heap-leaks skill with its script", () => {
    const scriptPath = path.join(
      repoRoot,
      ".agents",
      "skills",
      "openclaw-test-heap-leaks",
      "scripts",
      "heapsnapshot-delta.mjs",
    );
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("still contains the security-triage skill", () => {
    const skillPath = path.join(repoRoot, ".agents", "skills", "security-triage", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
  });

  it("still contains the openclaw-pr-maintainer skill", () => {
    const skillPath = path.join(
      repoRoot,
      ".agents",
      "skills",
      "openclaw-pr-maintainer",
      "SKILL.md",
    );
    expect(existsSync(skillPath)).toBe(true);
  });

  it("still contains the openclaw-release-maintainer skill", () => {
    const skillPath = path.join(
      repoRoot,
      ".agents",
      "skills",
      "openclaw-release-maintainer",
      "SKILL.md",
    );
    expect(existsSync(skillPath)).toBe(true);
  });
});
