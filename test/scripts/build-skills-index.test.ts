import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function createTempSkillsRoot() {
  const skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-index-"));
  tempDirs.push(skillsRoot);
  return skillsRoot;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("build-skills-index.mjs", () => {
  it("includes symlinked skill directories in the generated index", async () => {
    const skillsRoot = await createTempSkillsRoot();
    const actualSkillDir = path.join(skillsRoot, "actual-skill");
    const linkedSkillDir = path.join(skillsRoot, "linked-skill");

    await fs.mkdir(actualSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(actualSkillDir, "SKILL.md"),
      "---\nname: actual-skill\ndescription: test\n---\n",
      "utf-8",
    );
    await fs.symlink(actualSkillDir, linkedSkillDir);

    await execFileAsync("node", ["scripts/build-skills-index.mjs", skillsRoot], {
      cwd: "/Users/knox/repos/openclaw",
    });

    const index = JSON.parse(
      await fs.readFile(path.join(skillsRoot, "skills-index.json"), "utf-8"),
    ) as {
      skills: Array<{ path: string }>;
    };
    expect(index.skills.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["actual-skill", "linked-skill"]),
    );
  });
});
