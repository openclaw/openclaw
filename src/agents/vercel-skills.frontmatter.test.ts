import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter, resolveOpenClawMetadata } from "./skills/frontmatter.js";

function loadSkill(relativePath: string) {
  const skillPath = path.join(process.cwd(), relativePath);

  if (!fs.existsSync(skillPath)) {
    throw new Error(`Skill file not found: ${skillPath}`);
  }

  const raw = fs.readFileSync(skillPath, "utf-8");
  const frontmatter = parseFrontmatter(raw);
  const metadata = resolveOpenClawMetadata(frontmatter);
  return { frontmatter, metadata, raw };
}

describe("vercel bundled skill frontmatter", () => {
  it("keeps VERCEL_TOKEN wiring and node install metadata intact", () => {
    const vercel = loadSkill(path.join("skills", "vercel", "SKILL.md"));

    expect(vercel.frontmatter.description).toContain("Read-only Vercel inspection");
    expect(vercel.metadata?.skillKey).toBe("vercel");
    expect(vercel.metadata?.primaryEnv).toBe("VERCEL_TOKEN");
    expect(vercel.metadata?.os).toEqual(["darwin", "linux"]);
    expect(vercel.metadata?.requires?.bins).toContain("vercel");
    expect(vercel.metadata?.requires?.env).toContain("VERCEL_TOKEN");
    expect(vercel.metadata?.install?.[0]?.kind).toBe("node");
    expect(vercel.metadata?.install?.[0]?.package).toBe("vercel@50.37.0");
  });

  it("keeps the skill read-only", () => {
    const vercel = loadSkill(path.join("skills", "vercel", "SKILL.md"));
    const raw = vercel.raw;
    const forbiddenCommands = [
      "vercel deploy",
      "vercel link",
      "vercel env add",
      "vercel env pull",
      "vercel env rm",
      "vercel domains add",
      "vercel domains rm",
      "vercel alias",
      "vercel teams add",
      "vercel teams invite",
    ];

    expect(raw).toContain("Read-only.");
    expect(raw).toContain("Never deploy.");
    expect(raw).toContain("Never link a project.");
    expect(raw).toContain("## Token Scope");
    expect(raw).toContain("bash ./skills/vercel/vercel-readonly.sh");
    expect(raw).toContain("skills.entries.vercel.apiKey");
    expect(raw).toContain(
      "`skills.entries.vercel.env.VERCEL_TOKEN` is only suitable for a literal string override.",
    );
    expect(raw).toContain("does not accept a SecretRef object");
    for (const command of forbiddenCommands) {
      expect(raw).not.toContain(command);
    }
  });
});
