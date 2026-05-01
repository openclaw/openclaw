import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Skill } from "../skills/skill-contract.js";
import { createSkillViewTool } from "./skill-view-tool.js";

let tmpDir: string;

function makeSkill(name: string, description: string, filePath: string): Skill {
  return { name, description, filePath } as Skill;
}

async function writeSkill(name: string, content = `# ${name}\n`): Promise<Skill> {
  const dir = path.join(tmpDir, name);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "SKILL.md");
  await fs.writeFile(filePath, content, "utf8");
  return makeSkill(name, `${name} description`, filePath);
}

describe("skill_view tool", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-view-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads the matched skill file and prefers exact match over case-insensitive match", async () => {
    const exact = await writeSkill("Demo", "# exact\n");
    const ci = await writeSkill("demo", "# lower\n");
    const tool = createSkillViewTool({ resolvedSkills: [ci, exact] });

    const result = await tool.execute("call", { name: "Demo" });

    expect(result.details).toMatchObject({
      ok: true,
      skill: { name: "Demo" },
      content: "# exact\n",
    });
  });

  it("falls back to a case-insensitive name match", async () => {
    const resolved = await writeSkill("Memory-Access", "# Memory\n");
    const tool = createSkillViewTool({ resolvedSkills: [resolved] });

    const result = await tool.execute("call", { name: "memory-access" });

    expect(result.details).toMatchObject({ ok: true, skill: { name: "Memory-Access" } });
  });

  it("reads an optional relative file contained in the skill directory", async () => {
    const resolved = await writeSkill("demo");
    await fs.mkdir(path.join(tmpDir, "demo", "docs"));
    await fs.writeFile(path.join(tmpDir, "demo", "docs", "extra.md"), "extra", "utf8");
    const tool = createSkillViewTool({ resolvedSkills: [resolved] });

    const result = await tool.execute("call", { name: "demo", file: "docs/extra.md" });

    expect(result.details).toMatchObject({ ok: true, content: "extra" });
  });

  it("rejects absolute, url-like, and parent-relative file paths", async () => {
    const resolved = await writeSkill("demo");
    const tool = createSkillViewTool({ resolvedSkills: [resolved] });

    await expect(
      tool.execute("call", { name: "demo", file: "/etc/passwd" }),
    ).resolves.toHaveProperty("details.ok", false);
    await expect(
      tool.execute("call", { name: "demo", file: "https://example.com/SKILL.md" }),
    ).resolves.toHaveProperty("details.ok", false);
    await expect(
      tool.execute("call", { name: "demo", file: "../outside.md" }),
    ).resolves.toHaveProperty("details.ok", false);
  });

  it("rejects symlink escapes after realpath containment", async () => {
    const resolved = await writeSkill("demo");
    const outside = path.join(tmpDir, "outside.txt");
    await fs.writeFile(outside, "secret", "utf8");
    await fs.symlink(outside, path.join(tmpDir, "demo", "link.txt"));
    const tool = createSkillViewTool({ resolvedSkills: [resolved] });

    const result = await tool.execute("call", { name: "demo", file: "link.txt" });

    expect(result.details).toMatchObject({ ok: false, error: "file escapes skill directory" });
  });

  it("rejects directories, oversized files, and reports close matches", async () => {
    const resolved = await writeSkill("memory-access", "123456");
    const tool = createSkillViewTool({ resolvedSkills: [resolved], maxBytes: 3 });

    await expect(
      tool.execute("call", { name: "memory-access", file: "." }),
    ).resolves.toHaveProperty("details.ok", false);
    await expect(tool.execute("call", { name: "memory-access" })).resolves.toMatchObject({
      details: { ok: false, error: "file too large", bytes: 6, maxBytes: 3 },
    });

    const missing = await tool.execute("call", { name: "memory" });
    expect(missing.details).toMatchObject({
      ok: false,
      error: "skill not found",
      closeMatches: [{ name: "memory-access" }],
    });
  });
});
