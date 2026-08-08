import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSkillsFromDirSafe, readSkillFrontmatterSafe } from "./local-loader.js";

const isWindows = process.platform === "win32";

const tmpTracker = createTempDirTracker();

// Create a controlled external payload file to replace the unstable /etc/passwd
const outsidePayloadPath = path.join(
  os.tmpdir(),
  `openclaw-sandbox-escape-payload-${randomUUID()}.md`,
);
fsSync.writeFileSync(
  outsidePayloadPath,
  "---\nname: stolen\ndescription: escaped payload\n---\n",
  "utf-8",
);

afterAll(() => {
  tmpTracker.cleanup();
  fsSync.rmSync(outsidePayloadPath, { force: true });
});

function tmpDir(): string {
  return tmpTracker.make("local-loader-test-");
}

function writeSkill(dir: string, name: string, description: string, extra = "") {
  fsSync.mkdirSync(dir, { recursive: true });
  const extraBlock = extra ? `\n${extra}` : "";
  fsSync.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}${extraBlock}\n---\n\n# ${name}\n`,
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// loadSkillsFromDirSafe - Functional Tests
// ---------------------------------------------------------------------------

describe("loadSkillsFromDirSafe", () => {
  it("loads a single root skill when dir itself contains SKILL.md", () => {
    const dir = tmpDir();
    writeSkill(dir, "root-skill", "A root skill");

    const result = loadSkillsFromDirSafe({ dir, source: "workspace" });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("root-skill");
    expect(result.skills[0].description).toBe("A root skill");
    expect(result.skills[0].source).toBe("workspace");
  });

  it("loads skills from subdirectories", () => {
    const root = tmpDir();
    writeSkill(path.join(root, "skill-a"), "skill-a", "First skill");
    writeSkill(path.join(root, "skill-b"), "skill-b", "Second skill");

    const result = loadSkillsFromDirSafe({ dir: root, source: "workspace" });
    expect(result.skills).toHaveLength(2);
    const names = result.skills.map((s) => s.name).toSorted();
    expect(names).toStrictEqual(["skill-a", "skill-b"]);
  });

  it("returns empty for a missing directory", () => {
    const result = loadSkillsFromDirSafe({
      dir: path.join(os.tmpdir(), `openclaw-nonexistent-${randomUUID()}`),
      source: "workspace",
    });
    expect(result.skills).toStrictEqual([]);
    expect(result.frontmatterByFilePath.size).toBe(0);
  });

  it("returns empty for an empty directory", () => {
    const dir = tmpDir();
    const result = loadSkillsFromDirSafe({ dir, source: "workspace" });
    expect(result.skills).toStrictEqual([]);
  });

  it("skips dot-prefixed directories", () => {
    const root = tmpDir();
    writeSkill(path.join(root, "valid-skill"), "valid", "Good skill");
    writeSkill(path.join(root, ".hidden"), "hidden", "Hidden skill");

    const result = loadSkillsFromDirSafe({ dir: root, source: "workspace" });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("valid");
  });

  it("skips node_modules directory", () => {
    const root = tmpDir();
    writeSkill(path.join(root, "valid-skill"), "valid", "Good skill");
    writeSkill(path.join(root, "node_modules"), "nm", "NM skill");

    const result = loadSkillsFromDirSafe({ dir: root, source: "workspace" });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("valid");
  });

  it("skips directories without a valid SKILL.md", () => {
    const root = tmpDir();
    writeSkill(path.join(root, "valid-skill"), "valid", "Good skill");
    fsSync.mkdirSync(path.join(root, "no-skill"), { recursive: true });
    fsSync.writeFileSync(path.join(root, "no-skill", "README.md"), "# nothing\n", "utf-8");

    const result = loadSkillsFromDirSafe({ dir: root, source: "workspace" });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("valid");
  });

  it("skips subdirectory whose SKILL.md lacks a description", () => {
    const root = tmpDir();
    writeSkill(path.join(root, "valid"), "good", "Good skill");
    fsSync.mkdirSync(path.join(root, "no-desc"), { recursive: true });
    fsSync.writeFileSync(
      path.join(root, "no-desc", "SKILL.md"),
      "---\nname: no-desc\n---\n\n# No Desc\n",
      "utf-8",
    );

    const result = loadSkillsFromDirSafe({ dir: root, source: "workspace" });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("good");
  });

  it("uses directory basename as fallback name", () => {
    const root = tmpDir();
    const skillDir = path.join(root, "fallback-name-skill");
    fsSync.mkdirSync(skillDir, { recursive: true });
    fsSync.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\ndescription: No name in frontmatter\n---\n\n# Fallback\n",
      "utf-8",
    );

    const result = loadSkillsFromDirSafe({ dir: root, source: "workspace" });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("fallback-name-skill");
  });

  it("assigns a deterministic promptVersion", () => {
    const dir = tmpDir();
    writeSkill(dir, "versioned", "Has a version");

    const result = loadSkillsFromDirSafe({ dir, source: "workspace" });
    expect(result.skills[0].promptVersion).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it("returns frontmatterByFilePath map", () => {
    const root = tmpDir();
    writeSkill(path.join(root, "skill-a"), "skill-a", "First");
    writeSkill(path.join(root, "skill-b"), "skill-b", "Second");

    const result = loadSkillsFromDirSafe({ dir: root, source: "workspace" });
    expect(result.frontmatterByFilePath.size).toBe(2);
    for (const skill of result.skills) {
      expect(result.frontmatterByFilePath.has(skill.filePath)).toBe(true);
      const fm = result.frontmatterByFilePath.get(skill.filePath);
      expect(fm?.name).toBe(skill.name);
    }
  });

  it("enforces maxBytes limit", () => {
    const dir = tmpDir();
    writeSkill(dir, "huge", "A skill");
    const hugePath = path.join(dir, "SKILL.md");
    fsSync.writeFileSync(hugePath, "x".repeat(500), "utf-8");

    const result = loadSkillsFromDirSafe({
      dir,
      source: "workspace",
      maxBytes: 100,
    });
    expect(result.skills).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadSkillsFromDirSafe - Sandbox Escape Prevention
// ---------------------------------------------------------------------------

describe("loadSkillsFromDirSafe sandbox escape prevention", () => {
  it("skips a skill whose SKILL.md is a symlink to a file outside the root", () => {
    if (isWindows) {
      return;
    }

    const root = tmpDir();
    writeSkill(path.join(root, "legit"), "legit", "Legitimate skill");

    const escapeDir = path.join(root, "escape");
    fsSync.mkdirSync(escapeDir, { recursive: true });
    fsSync.symlinkSync(outsidePayloadPath, path.join(escapeDir, "SKILL.md"));

    const result = loadSkillsFromDirSafe({ dir: root, source: "workspace" });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("legit");
  });

  it("skips a skill whose entire directory is a symlink to an outside location", () => {
    if (isWindows) {
      return;
    }

    const root = tmpDir();
    const outsideDir = tmpTracker.make(`outside-legit-${randomUUID()}-`);
    fsSync.mkdirSync(outsideDir, { recursive: true });
    writeSkill(outsideDir, "outside", "Outside skill");

    writeSkill(path.join(root, "legit"), "legit", "Legitimate skill");

    const symlinkDir = path.join(root, "linked-outside");
    fsSync.symlinkSync(outsideDir, symlinkDir);

    const result = loadSkillsFromDirSafe({ dir: root, source: "workspace" });
    expect(result.skills).toHaveLength(1);
    const names = result.skills.map((s) => s.name);
    expect(names).toStrictEqual(["legit"]);
    expect(names).not.toContain("outside");
  });

  it("does not flag a symlink within the same root boundary", () => {
    if (isWindows) {
      return;
    }

    const root = tmpDir();
    const innerDir = path.join(root, "real-skill");
    fsSync.mkdirSync(innerDir, { recursive: true });
    writeSkill(innerDir, "inner", "Inner skill");

    const redirectDir = path.join(root, "redirect");
    fsSync.mkdirSync(redirectDir, { recursive: true });
    fsSync.symlinkSync(path.join(innerDir, "SKILL.md"), path.join(redirectDir, "SKILL.md"));

    const result = loadSkillsFromDirSafe({ dir: root, source: "workspace" });
    expect(result.skills.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// readSkillFrontmatterSafe - Functional & Security Tests
// ---------------------------------------------------------------------------

describe("readSkillFrontmatterSafe", () => {
  it("reads valid frontmatter from a SKILL.md", () => {
    const root = tmpDir();
    writeSkill(root, "test-skill", "A test");

    const fm = readSkillFrontmatterSafe({
      rootDir: root,
      filePath: path.join(root, "SKILL.md"),
    });

    expect(fm).not.toBeNull();
    expect(fm?.name).toBe("test-skill");
    expect(fm?.description).toBe("A test");
  });

  it("returns null when rootDir does not exist", () => {
    const result = readSkillFrontmatterSafe({
      rootDir: path.join(os.tmpdir(), `openclaw-nonexistent-${randomUUID()}`),
      filePath: "/some/file.md",
    });
    expect(result).toBeNull();
  });

  it("returns null when file does not exist", () => {
    const root = tmpDir();
    const result = readSkillFrontmatterSafe({
      rootDir: root,
      filePath: path.join(root, "no-such-file.md"),
    });
    expect(result).toBeNull();
  });

  it("returns empty object for content without frontmatter delimiters", () => {
    const root = tmpDir();
    fsSync.writeFileSync(path.join(root, "plain.md"), "# Just a heading\n", "utf-8");

    const result = readSkillFrontmatterSafe({
      rootDir: root,
      filePath: path.join(root, "plain.md"),
    });
    expect(result).toStrictEqual({});
  });

  it("returns null when filePath escapes rootDir via symlink", () => {
    if (isWindows) {
      return;
    }

    const root = tmpDir();
    const symlinkPath = path.join(root, "escaped-link.md");
    fsSync.symlinkSync(outsidePayloadPath, symlinkPath);

    const result = readSkillFrontmatterSafe({
      rootDir: root,
      filePath: symlinkPath,
    });

    expect(result).toBeNull();
  });

  it("returns null when filePath uses path traversal to escape rootDir", () => {
    const root = tmpDir();
    const traversalPath = path.join(root, "..", path.basename(outsidePayloadPath));

    const result = readSkillFrontmatterSafe({
      rootDir: root,
      filePath: traversalPath,
    });

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("loadSkillsFromDirSafe edge cases", () => {
  it("handles a directory with only dotfiles gracefully", () => {
    const root = tmpDir();
    fsSync.mkdirSync(path.join(root, ".config"), { recursive: true });
    writeSkill(path.join(root, ".config"), "config", "Config");

    const result = loadSkillsFromDirSafe({ dir: root, source: "workspace" });
    expect(result.skills).toStrictEqual([]);
  });

  it("handles mixture of valid, invalid, and filtered directories", () => {
    const root = tmpDir();
    writeSkill(path.join(root, "good"), "good", "Valid skill");
    fsSync.mkdirSync(path.join(root, ".secret"), { recursive: true });
    writeSkill(path.join(root, ".secret"), "secret", "Hidden");
    fsSync.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeSkill(path.join(root, "node_modules"), "nm", "NM");
    fsSync.mkdirSync(path.join(root, "broken"), { recursive: true });
    fsSync.writeFileSync(path.join(root, "broken", "SKILL.md"), "not valid frontmatter\n", "utf-8");

    const result = loadSkillsFromDirSafe({ dir: root, source: "workspace" });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("good");
  });
});
