import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSkillsFromDir } from "./session.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("loadSkillsFromDir", () => {
  it("reports directory scan failures as diagnostics", async () => {
    const tempDir = tempDirs.make("openclaw-skill-scan-");
    const regularFile = path.join(tempDir, "not-a-directory");
    await fs.writeFile(regularFile, "not a skill directory");

    const result = loadSkillsFromDir({ dir: regularFile, source: "test" });

    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ type: "warning", path: regularFile }),
    ]);
  });

  it("does not load dash-prefixed Markdown as frontmatter", async () => {
    const tempDir = tempDirs.make("openclaw-skill-scan-");
    const skillDir = path.join(tempDir, "dash-prefix");
    await fs.mkdir(skillDir);
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.writeFile(
      skillFile,
      "----\nname: bogus\ndescription: must remain Markdown\n---\n# Body\n",
      "utf-8",
    );

    const result = loadSkillsFromDir({ dir: tempDir, source: "test" });

    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toContainEqual({
      type: "warning",
      message: "description is required",
      path: skillFile,
    });
  });
});
