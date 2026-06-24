// Session resilience tests cover error isolation during skill directory scanning.
// A single broken skill file must not prevent other skills in the same directory from loading.
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { loadSkillsFromDir } from "./session.js";

describe("loadSkillsFromDir error isolation", () => {
  it("continues loading other skills when one root .md file throws during read", async () => {
    await withTempDir("openclaw-skill-resilience-", async (tmpDir) => {
      // Create two .md skill files in the root directory
      const goodSkillPath = path.join(tmpDir, "good-skill.md");
      const badSkillPath = path.join(tmpDir, "bad-skill.md");

      // Good skill: valid frontmatter
      await fsPromises.writeFile(
        goodSkillPath,
        ["---", "name: good-skill", "description: A working skill", "---", "# Good Skill", ""].join(
          "\n",
        ),
        "utf-8",
      );

      // Bad skill: valid frontmatter but we'll make it unreadable via permissions
      await fsPromises.writeFile(
        badSkillPath,
        ["---", "name: bad-skill", "description: A broken skill", "---", "# Bad Skill", ""].join(
          "\n",
        ),
        "utf-8",
      );

      // Make the bad file unreadable (chmod 000)
      fs.chmodSync(badSkillPath, 0o000);

      const result = loadSkillsFromDir({ dir: tmpDir, source: "test" });

      // The good skill should still be loaded
      const goodSkill = result.skills.find((s) => s.name === "good-skill");
      expect(goodSkill).toBeDefined();
      expect(goodSkill!.description).toBe("A working skill");

      // There should be a diagnostic warning for the bad skill
      const warningForBad = result.diagnostics.find(
        (d) => d.type === "warning" && d.message.includes("bad-skill.md"),
      );
      expect(warningForBad).toBeDefined();

      // Restore permissions so cleanup can delete it
      try {
        fs.chmodSync(badSkillPath, 0o644);
      } catch {
        // best effort
      }
    });
  });

  it("continues loading other skills when one subdirectory skill throws", async () => {
    await withTempDir("openclaw-skill-resilience-", async (tmpDir) => {
      // good-skill/ directory with valid SKILL.md
      const goodDir = path.join(tmpDir, "good-skill");
      await fsPromises.mkdir(goodDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(goodDir, "SKILL.md"),
        [
          "---",
          "name: good-skill",
          "description: Working subdirectory skill",
          "---",
          "# Good",
          "",
        ].join("\n"),
        "utf-8",
      );

      // bad-skill/ directory with SKILL.md that has invalid frontmatter (unparseable)
      const badDir = path.join(tmpDir, "bad-skill");
      await fsPromises.mkdir(badDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(badDir, "SKILL.md"),
        "---\nthis is not: valid yaml: [[[nope\n---\n# Broken\n",
        "utf-8",
      );

      // another-skill/ directory with valid SKILL.md
      const anotherDir = path.join(tmpDir, "another-skill");
      await fsPromises.mkdir(anotherDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(anotherDir, "SKILL.md"),
        [
          "---",
          "name: another-skill",
          "description: Another working skill",
          "---",
          "# Another",
          "",
        ].join("\n"),
        "utf-8",
      );

      const result = loadSkillsFromDir({ dir: tmpDir, source: "test" });

      // Both good skills should be loaded despite the bad one
      const goodSkill = result.skills.find((s) => s.name === "good-skill");
      const anotherSkill = result.skills.find((s) => s.name === "another-skill");
      expect(goodSkill).toBeDefined();
      expect(anotherSkill).toBeDefined();

      // bad-skill should not be loaded (missing description after parse failure)
      const badSkill = result.skills.find((s) => s.name === "bad-skill");
      expect(badSkill).toBeUndefined();

      // There should be diagnostics for the bad skill
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });
  });

  it("returns empty result with no diagnostics for a non-existent directory", () => {
    const result = loadSkillsFromDir({
      dir: path.join(os.tmpdir(), "openclaw-nonexistent-" + Date.now()),
      source: "test",
    });

    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("loads all valid root .md files when no errors occur", async () => {
    await withTempDir("openclaw-skill-resilience-", async (tmpDir) => {
      for (const name of ["alpha", "beta", "gamma"]) {
        const filePath = path.join(tmpDir, `${name}.md`);
        await fsPromises.writeFile(
          filePath,
          ["---", `name: ${name}`, `description: ${name} skill`, "---", `# ${name}`, ""].join("\n"),
          "utf-8",
        );
      }

      const result = loadSkillsFromDir({ dir: tmpDir, source: "test" });

      expect(result.skills.map((s) => s.name).toSorted()).toEqual(["alpha", "beta", "gamma"]);
      expect(result.diagnostics).toEqual([]);
    });
  });
});
