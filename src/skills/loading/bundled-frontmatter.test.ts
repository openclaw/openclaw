// Bundled frontmatter tests cover metadata validity for bundled skills.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFrontmatter, resolveOpenClawMetadata } from "./frontmatter.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("bundled taskflow skill frontmatter", () => {
  it("keeps the taskflow skills parseable from their shipped files", async () => {
    const skillPaths = [
      "skills/taskflow/SKILL.md",
      "skills/taskflow-inbox-triage/SKILL.md",
    ] as const;

    for (const relativePath of skillPaths) {
      const raw = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
      const frontmatter = parseFrontmatter(raw);

      expect(frontmatter.name, relativePath).toBeTypeOf("string");
      expect(frontmatter.name?.trim(), relativePath).not.toBe("");
      expect(frontmatter.description, relativePath).toBeTypeOf("string");
      expect(frontmatter.description?.trim(), relativePath).not.toBe("");
    }
  });
});

describe("bundled atomicmail skill", () => {
  const skillDir = path.join(repoRoot, "skills", "atomicmail");

  it("has parseable frontmatter with the expected name", async () => {
    const raw = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    const frontmatter = parseFrontmatter(raw);

    expect(frontmatter.name).toBe("atomicmail");
    expect(frontmatter.description?.trim()).not.toBe("");
  });

  it("declares the atomicmail bin requirement and npm install recipe", async () => {
    const raw = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    const metadata = resolveOpenClawMetadata(parseFrontmatter(raw));

    expect(metadata?.requires?.bins).toContain("atomicmail");

    const nodeInstall = metadata?.install?.find((spec) => spec.kind === "node");
    expect(nodeInstall).toBeDefined();
    expect(nodeInstall?.package).toBe("@atomicmail/agent-skill-openclaw");
    expect(nodeInstall?.bins).toContain("atomicmail");
  });

  it("stays a thin wrapper without vendored runtime files", async () => {
    const entries = await fs.readdir(skillDir);
    expect(entries).toContain("SKILL.md");
    expect(entries).not.toContain("lib");
    expect(entries).not.toContain("scripts");
  });
});
