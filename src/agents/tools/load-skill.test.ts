import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Skill } from "@mariozechner/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clampSkillContent,
  createLoadSkillTool,
  LOAD_SKILL_MAX_BYTES,
  readSkillByName,
} from "./load-skill.js";

// Minimal Skill mock at the test boundary (the pi Skill type has more fields than
// the tool reads).
function skill(name: string, baseDir: string, filePath: string, description = "desc"): Skill {
  return { name, description, filePath, baseDir } as unknown as Skill;
}

describe("clampSkillContent", () => {
  it("returns content unchanged under the cap", () => {
    expect(clampSkillContent("hello")).toBe("hello");
  });
  it("clamps content over the cap to the byte boundary", () => {
    const out = clampSkillContent("a".repeat(LOAD_SKILL_MAX_BYTES + 100));
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(LOAD_SKILL_MAX_BYTES);
  });
  it("drops a straddled trailing multi-byte char (no replacement char)", () => {
    const out = clampSkillContent("a".repeat(LOAD_SKILL_MAX_BYTES - 1) + "é");
    expect(out.endsWith("�")).toBe(false);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(LOAD_SKILL_MAX_BYTES);
  });
});

describe("readSkillByName", () => {
  let root: string;
  let alphaDir: string; // workspace-style root
  let betaDir: string; // a different (bundled-style) root

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "load-skill-"));
    alphaDir = path.join(root, "ws", "skills", "alpha");
    betaDir = path.join(root, "bundled", "skills", "beta");
    await fs.mkdir(alphaDir, { recursive: true });
    await fs.mkdir(betaDir, { recursive: true });
    await fs.writeFile(path.join(alphaDir, "SKILL.md"), "ALPHA BODY", "utf-8");
    await fs.writeFile(path.join(betaDir, "SKILL.md"), "BETA BODY", "utf-8");
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const skills = (): Skill[] => [
    skill("alpha", alphaDir, path.join(alphaDir, "SKILL.md")),
    skill("beta", betaDir, path.join(betaDir, "SKILL.md")),
  ];

  it("loads a skill by exact name across distinct roots (codex #1 multi-root)", async () => {
    expect(await readSkillByName(skills(), "alpha")).toMatchObject({
      ok: true,
      name: "alpha",
      content: "ALPHA BODY",
    });
    expect(await readSkillByName(skills(), "beta")).toMatchObject({
      ok: true,
      content: "BETA BODY",
    });
  });

  it("trims the input name", async () => {
    expect((await readSkillByName(skills(), "  alpha  ")).ok).toBe(true);
  });

  it("rejects an unknown name and lists available (no side channel)", async () => {
    const r = await readSkillByName(skills(), "gamma");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("alpha, beta");
    }
  });

  it("rejects path-like input (only names match the allowlist)", async () => {
    for (const bad of ["../alpha", "/etc/passwd", "alpha/SKILL.md", "~/x"]) {
      expect((await readSkillByName(skills(), bad)).ok).toBe(false);
    }
  });

  it("rejects a SKILL.md that symlinks outside its skill dir", async () => {
    const secret = path.join(root, "secret.md");
    await fs.writeFile(secret, "SECRET", "utf-8");
    const evilDir = path.join(root, "ws", "skills", "evil");
    await fs.mkdir(evilDir, { recursive: true });
    await fs.symlink(secret, path.join(evilDir, "SKILL.md"));
    const r = await readSkillByName(
      [skill("evil", evilDir, path.join(evilDir, "SKILL.md"))],
      "evil",
    );
    expect(r.ok).toBe(false);
  });

  it("truncates oversize content with truncated:true", async () => {
    const bigDir = path.join(root, "ws", "skills", "big");
    await fs.mkdir(bigDir, { recursive: true });
    await fs.writeFile(
      path.join(bigDir, "SKILL.md"),
      "x".repeat(LOAD_SKILL_MAX_BYTES + 500),
      "utf-8",
    );
    const r = await readSkillByName([skill("big", bigDir, path.join(bigDir, "SKILL.md"))], "big");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(true);
      expect(Buffer.byteLength(r.content, "utf8")).toBeLessThanOrEqual(LOAD_SKILL_MAX_BYTES);
    }
  });
});

describe("createLoadSkillTool", () => {
  it("returns null when there is no app-skill allowlist", () => {
    expect(createLoadSkillTool({})).toBeNull();
    expect(createLoadSkillTool({ skills: [] })).toBeNull();
  });
  it("returns a load_skill tool when skills are present", () => {
    const tool = createLoadSkillTool({ skills: [skill("alpha", "/x", "/x/SKILL.md")] });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("load_skill");
  });
});
