// Session skill loading tests cover directory scanning and error propagation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { loadSkillsFromDir } from "./session.js";

describe("loadSkillsFromDir", () => {
  let tmpDir: string;
  let skillsDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-session-"));
    skillsDir = path.join(tmpDir, "skills");
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads a valid skill from a subdirectory", async () => {
    await writeSkill({
      dir: path.join(skillsDir, "my-skill"),
      name: "my-skill",
      description: "A valid test skill",
    });

    const result = loadSkillsFromDir({ dir: skillsDir, source: "test" });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("my-skill");
    expect(result.skills[0].description).toBe("A valid test skill");
    expect(result.diagnostics).toEqual([]);
  });

  it("captures unreadable subdirectory errors as diagnostics", async () => {
    // Create a subdirectory that exists but cannot be listed
    const badDir = path.join(skillsDir, "unreadable");
    await fs.mkdir(badDir, { recursive: true });
    await writeSkill({
      dir: path.join(badDir, "hidden-skill"),
      name: "hidden-skill",
      description: "This should not load",
    });
    // Remove all permissions so readdirSync fails with EACCES
    await fs.chmod(badDir, 0o000);

    try {
      const result = loadSkillsFromDir({ dir: skillsDir, source: "test" });

      // The symptom fixed by bug-010: previously the EACCES error was silently
      // swallowed by an empty catch {} and no diagnostic was produced.
      expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(result.diagnostics.some((d) => d.path === badDir)).toBe(true);
      // Every diagnostic from this code path has type "warning"
      expect(result.diagnostics.every((d) => d.type === "warning")).toBe(true);
    } finally {
      // Restore permissions so cleanup can delete it
      await fs.chmod(badDir, 0o755).catch(() => {});
    }
  });
});
