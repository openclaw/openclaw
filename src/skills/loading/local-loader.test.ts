// Local loader tests cover author-facing skip diagnostics for malformed SKILL.md files.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkillsFromDirSafe } from "./local-loader.js";

const tempDirs: string[] = [];

async function makeSkillsRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-loader-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("loadSkillsFromDirSafe skip diagnostics", () => {
  it("reports a SKILL.md missing description, naming the specific field", async () => {
    const root = await makeSkillsRoot();
    const skillDir = path.join(root, "no-description");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: no-description\n---\n\nBody.\n",
      "utf8",
    );

    const result = loadSkillsFromDirSafe({ dir: root, source: "test" });

    expect(result.skills).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    const failure = result.skipped[0]!;
    expect(failure.reason).toBe("missing-required-field");
    if (failure.reason === "missing-required-field") {
      expect(failure.field).toBe("description");
    }
    expect(failure.filePath).toBe(path.join(skillDir, "SKILL.md"));
  });

  it("loads valid skills while still surfacing malformed siblings", async () => {
    const root = await makeSkillsRoot();
    const goodDir = path.join(root, "good");
    await fs.mkdir(goodDir, { recursive: true });
    await fs.writeFile(
      path.join(goodDir, "SKILL.md"),
      "---\nname: good\ndescription: A valid skill.\n---\n\nBody.\n",
      "utf8",
    );
    const badDir = path.join(root, "bad");
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, "SKILL.md"), "---\nname: bad\n---\n", "utf8");

    const result = loadSkillsFromDirSafe({ dir: root, source: "test" });

    expect(result.skills.map((s) => s.name)).toEqual(["good"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toBe("missing-required-field");
  });
});
