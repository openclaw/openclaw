import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNodeHostedSkillDirectory, scanNodeHostedSkills } from "./skills.js";

const roots: string[] = [];
function makeSkills() {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "node-skills-")));
  roots.push(stateDir);
  const root = path.join(stateDir, "skills");
  fs.mkdirSync(root);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const write = (relative: string, content: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return {
    root,
    stateDir,
    write,
    warn,
    skill: (name: string, description: string, body = "# Instructions") => {
      const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
      write(`${name}/SKILL.md`, content);
      return content;
    },
    scan: () => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      return scanNodeHostedSkills();
    },
    warning: (text: string) => expect(warn).toHaveBeenCalledWith(expect.stringContaining(text)),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("scanNodeHostedSkills", () => {
  it("resolves custom-profile locators and rejects other nodes, traversal, and symlink escapes", () => {
    const { stateDir, root, skill } = makeSkills();
    skill("profile-skill", "Profile skill");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const resolve = (locator: string) => resolveNodeHostedSkillDirectory(locator, "node-1");
    expect(resolve("node://node-1/skills/profile-skill")).toBe(path.join(root, "profile-skill"));
    for (const locator of [
      "node://node-2/skills/profile-skill",
      "node://node-1/skills/../profile-skill",
    ]) {
      expect(() => resolve(locator)).toThrow("invalid for this node");
    }
    if (process.platform !== "win32") {
      const outside = path.join(stateDir, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(
        path.join(outside, "SKILL.md"),
        "---\nname: outside\ndescription: Outside\n---\n",
      );
      fs.symlinkSync(outside, path.join(root, "escape"));
      expect(() => resolve("node://node-1/skills/escape")).toThrow("unavailable");
    }
  });

  it("treats a missing skills directory as an empty fresh-node inventory", () => {
    const { root, warn } = makeSkills();
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    expect(scanNodeHostedSkills()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("publishes the same bounded content that supplied the skill metadata", () => {
    const { skill, write, warn, scan, warning } = makeSkills();
    const content = skill("a-stable", "Original description", "# Original");
    const invalid = write("b-invalid/SKILL.md", "# Missing frontmatter\n");
    warn.mockImplementation((message: string) => {
      if (message.includes(invalid)) {
        skill("a-stable", "Replacement description", "# Replacement");
      }
    });
    expect(scan()).toEqual([{ name: "a-stable", description: "Original description", content }]);
    warning(invalid);
  });

  it("skips invalid and oversized skills with warnings", () => {
    const { skill, write, scan, warning } = makeSkills();
    skill("valid-skill", "Valid");
    write("invalid/SKILL.md", "# Missing frontmatter");
    const malformed = write("malformed/SKILL.md", "---\nname: [malformed\ndescription: Bad\n---\n");
    skill("oversized", "Oversized", "x".repeat(64 * 1024));
    write("folder-name/SKILL.md", "---\nname: other\ndescription: Mismatched\n---\n");
    expect(scan().map((entry) => entry.name)).toEqual(["valid-skill"]);
    for (const text of [
      "description is required",
      malformed,
      "BAD_INDENT",
      "exceeds 65536 bytes",
      "directory, name, and frontmatter",
    ]) {
      warning(text);
    }
  });

  it("does not inspect nested skills after rejecting the named candidate", () => {
    const { write, scan, warn, warning } = makeSkills();
    const candidate = write("candidate/SKILL.md", "# Missing frontmatter\n");
    const nested = write(
      "candidate/nested/SKILL.md",
      "---\nname: [nested\ndescription: Bad\n---\n",
    );
    expect(scan()).toEqual([]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(nested));
    warning(`${candidate}): description is required`);
  });

  it.each(["root skill", "unreadable root"])("continues scanning after %s", (mode) => {
    const { root, skill, write, scan, warning } = makeSkills();
    const content = skill("valid-child", "Valid child");
    if (mode === "root skill") {
      write("SKILL.md", "---\nname: skills\ndescription: Root skill\n---\n");
    } else {
      fs.symlinkSync("SKILL.md", path.join(root, "SKILL.md"));
      fs.mkdirSync(path.join(root, "broken-child"));
      fs.symlinkSync("SKILL.md", path.join(root, "broken-child/SKILL.md"));
    }
    expect(scan()).toEqual([{ name: "valid-child", description: "Valid child", content }]);
    warning(mode === "root skill" ? "named child directory" : "skill scan skipped");
    if (mode === "unreadable root") {
      warning("broken-child/SKILL.md");
    }
  });

  it.each([
    { count: 65, bytes: 0, accepted: 64, warning: "exceeds 64 skills" },
    { count: 9, bytes: 60 * 1024, accepted: 8, warning: "exceeds 524288 total bytes" },
  ])(
    "caps inventory at $accepted skills for $bytes-byte bodies",
    ({ count, bytes, accepted, warning }) => {
      const skills = makeSkills();
      const body = bytes ? "x".repeat(bytes) : "# Instructions";
      for (let index = 0; index < count; index++) {
        skills.skill(`skill-${String(index).padStart(2, "0")}`, "Skill", body);
      }
      expect(skills.scan()).toHaveLength(accepted);
      skills.warning(warning);
    },
  );
});
