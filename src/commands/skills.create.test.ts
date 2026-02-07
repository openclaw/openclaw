import fs from "fs";
import path from "path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { createSkill } from "./skills.create.js";

describe("skills.create", () => {
  const testDir = path.join(process.cwd(), "temp-test-skills");

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should create a skill structure", async () => {
    // Mock cwd to be a temp dir
    fs.mkdirSync(testDir, { recursive: true });
    
    await createSkill({ name: "my-test-skill", cwd: testDir });

    const skillPath = path.join(testDir, "skills", "my-test-skill");
    expect(fs.existsSync(path.join(skillPath, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(skillPath, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillPath, "src/index.ts"))).toBe(true);
    
    // Check content
    const pkg = JSON.parse(fs.readFileSync(path.join(skillPath, "package.json"), "utf-8"));
    expect(pkg.name).toBe("my-test-skill");
  });

  it("should validate name format", async () => {
    await expect(createSkill({ name: "Bad Name", cwd: testDir }))
      .rejects.toThrow(/must be kebab-case/);
  });
});
