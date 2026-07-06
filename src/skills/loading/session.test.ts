import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkillsFromDir } from "./session.js";

describe("loadSkillsFromDir", () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })),
    );
  });

  it("reports directory scan failures as diagnostics", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-scan-"));
    tempPaths.push(tempDir);
    const regularFile = path.join(tempDir, "not-a-directory");
    await fs.writeFile(regularFile, "not a skill directory");

    const result = loadSkillsFromDir({ dir: regularFile, source: "test" });

    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ type: "warning", path: regularFile }),
    ]);
  });
});
