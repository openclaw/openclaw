import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSkillsFromDirSafe, readSkillFrontmatterSafe } from "./local-loader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("loadSkillsFromDirSafe", () => {
  it("rejects an oversized SKILL.md through the bounded descriptor read", async () => {
    const tempDir = tempDirs.make("openclaw-local-loader-");
    const skillDir = path.join(tempDir, "oversized");
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, "SKILL.md");
    const oversizeBody = "x".repeat(512_000);
    await fs.writeFile(
      skillFile,
      `---\nname: oversized\ndescription: Too big\n---\n${oversizeBody}`,
      "utf-8",
    );

    const result = loadSkillsFromDirSafe({
      dir: tempDir,
      source: "openclaw-workspace",
      maxBytes: 256_000,
    });

    expect(result.skills).toEqual([]);
  });

  it("loads a SKILL.md that fits within the configured byte limit", async () => {
    const tempDir = tempDirs.make("openclaw-local-loader-");
    const skillDir = path.join(tempDir, "fits");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: fits\ndescription: Fits\n---\n# Fits\n",
      "utf-8",
    );

    const result = loadSkillsFromDirSafe({
      dir: tempDir,
      source: "openclaw-workspace",
      maxBytes: 256_000,
    });

    expect(result.skills.map((skill) => skill.name)).toEqual(["fits"]);
  });
});

describe("readSkillFrontmatterSafe", () => {
  it("returns null when the SKILL.md exceeds the byte limit", async () => {
    const tempDir = tempDirs.make("openclaw-local-loader-frontmatter-");
    const skillDir = path.join(tempDir, "oversized");
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, "SKILL.md");
    const oversizeBody = "x".repeat(512_000);
    await fs.writeFile(
      skillFile,
      `---\nname: oversized\ndescription: Too big\n---\n${oversizeBody}`,
      "utf-8",
    );

    const frontmatter = readSkillFrontmatterSafe({
      rootDir: tempDir,
      filePath: skillFile,
      maxBytes: 256_000,
    });

    expect(frontmatter).toBeNull();
  });
});
