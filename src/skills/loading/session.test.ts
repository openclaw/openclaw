import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSingleSkillDirectory, type LocalSkillLoadDiagnostic } from "./local-loader.js";
import { loadSkills } from "./session.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function loadSkillsFromPath(dir: string) {
  return loadSkills({ cwd: dir, agentDir: dir, skillPaths: [dir], includeDefaults: false });
}

describe("loadSingleSkillDirectory", () => {
  it.each([false])(
    "keeps cached content isolated from caller mutations, paths and read limits (declared name: %s)",
    async (declaredName) => {
      const root = tempDirs.make("openclaw-skill-content-cache-");
      const raw = [
        "---",
        ...(declaredName ? ["name: shared-cache-facts"] : []),
        "description: Cached instructions",
        "---",
        "Instructions without a heading.",
      ].join("\n");
      for (const name of ["first-copy", "second-copy"]) {
        const dir = path.join(root, name);
        await fs.mkdir(dir);
        await fs.writeFile(path.join(dir, "SKILL.md"), raw);
      }
      const firstParams = {
        skillDir: path.join(root, "first-copy"),
        rootRealPath: await fs.realpath(root),
        source: "openclaw-bundled",
      };
      const first = loadSingleSkillDirectory(firstParams)!;
      const hash = first.skill.contentHash;
      first.frontmatter.description = "Caller mutation";
      first.skill.description = "Caller mutation";
      first.skill.sourceInfo.scope = "temporary";
      expect(loadSingleSkillDirectory({ ...firstParams, maxBytes: 1 })).toBeNull();

      const skillDir = path.join(root, "second-copy");
      const second = loadSingleSkillDirectory({
        ...firstParams,
        skillDir,
        source: "openclaw-workspace",
      });
      expect(second?.frontmatter.description).toBe("Cached instructions");
      expect(second?.skill).toMatchObject({
        name: declaredName ? "shared-cache-facts" : "second-copy",
        displayName: declaredName ? "Shared Cache Facts" : "Second Copy",
        description: "Cached instructions",
        contentHash: hash,
        filePath: path.join(skillDir, "SKILL.md"),
        baseDir: skillDir,
        source: "openclaw-workspace",
        sourceInfo: {
          path: path.join(skillDir, "SKILL.md"),
          baseDir: skillDir,
          source: "openclaw-workspace",
          scope: "project",
        },
      });
    },
  );
});

describe("loadSkills", () => {
  it.each(["user", "project"] as const)(
    "preserves %s session provenance and its untrimmed fallback name beside local loading",
    async (source) => {
      const root = tempDirs.make("openclaw-skill-materialization-");
      const agentDir = path.join(root, "agent");
      const cwd = path.join(root, "project");
      const skillRoot =
        source === "user" ? path.join(agentDir, "skills") : path.join(cwd, ".openclaw", "skills");
      const skillDir = path.join(skillRoot, " padded-name");
      const filePath = path.join(skillDir, "SKILL.md");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        filePath,
        '---\ndescription: "  Padded metadata.  "\ndisable-model-invocation: true\n---\n# Shared Title\n',
      );

      const session = loadSkills({ cwd, agentDir, skillPaths: [filePath], includeDefaults: false });
      expect(session.skills).toEqual([
        {
          name: " padded-name",
          displayName: "Shared Title",
          description: "Padded metadata.",
          contentHash: expect.any(String),
          filePath,
          baseDir: skillDir,
          source,
          sourceInfo: {
            path: filePath,
            source: "local",
            scope: source,
            origin: "top-level",
            baseDir: skillDir,
          },
          disableModelInvocation: true,
        },
      ]);
      expect(session.diagnostics).toEqual([
        {
          type: "warning",
          path: filePath,
          message: "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
        },
      ]);

      const diagnostics: LocalSkillLoadDiagnostic[] = [];
      const local = loadSingleSkillDirectory({
        skillDir,
        source: "workspace",
        rootRealPath: await fs.realpath(skillDir),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      expect(local?.skill).toEqual({
        name: "padded-name",
        displayName: "Shared Title",
        description: "Padded metadata.",
        contentHash: session.skills[0]!.contentHash,
        filePath,
        baseDir: skillDir,
        source: "workspace",
        sourceInfo: {
          path: filePath,
          source: "workspace",
          scope: "project",
          origin: "top-level",
          baseDir: skillDir,
        },
        disableModelInvocation: true,
      });
      expect(diagnostics).toEqual([]);
    },
  );

  it("reports directory scan failures as diagnostics", async () => {
    const tempDir = tempDirs.make("openclaw-skill-scan-");
    const regularFile = path.join(tempDir, "not-a-directory");
    await fs.writeFile(regularFile, "not a skill directory");

    const result = loadSkillsFromPath(regularFile);

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

    const result = loadSkillsFromPath(tempDir);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toContainEqual({
      type: "warning",
      message: "description is required",
      path: skillFile,
    });
  });

  it("reports malformed frontmatter by file and keeps loading sibling skills", async () => {
    const tempDir = tempDirs.make("openclaw-skill-scan-");
    const brokenDir = path.join(tempDir, "broken");
    const validDir = path.join(tempDir, "valid");
    await fs.mkdir(brokenDir);
    await fs.mkdir(validDir);
    const brokenFile = path.join(brokenDir, "SKILL.md");
    await fs.writeFile(
      brokenFile,
      `---
name: [broken
description: Broken skill
---
`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(validDir, "SKILL.md"),
      `---
name: valid
description: Valid sibling
---
`,
      "utf-8",
    );

    const result = loadSkillsFromPath(tempDir);

    expect(result.skills.map((skill) => skill.name)).toEqual(["valid"]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        type: "warning",
        path: brokenFile,
        message: expect.stringContaining("invalid frontmatter: BAD_INDENT"),
      }),
    ]);
  });
});
