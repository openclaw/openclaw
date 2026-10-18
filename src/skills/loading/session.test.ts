import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSingleSkillDirectory, type LocalSkillLoadDiagnostic } from "./local-loader.js";
import { loadSkills } from "./session.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeRawSkill(dir: string, raw: string, filename = "SKILL.md") {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, raw, "utf-8");
  return filePath;
}

function loadSkillsFromPath(dir: string) {
  return loadSkills({ cwd: dir, agentDir: dir, skillPaths: [dir] });
}

it("keeps cached content isolated from caller mutations, paths and read limits", async () => {
  const root = tempDirs.make("openclaw-skill-content-cache-");
  const raw = "---\ndescription: Cached instructions\n---\nInstructions without a heading.";
  for (const name of ["first-copy", "second-copy"]) {
    const dir = path.join(root, name);
    await writeRawSkill(dir, raw);
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
    name: "second-copy",
    displayName: "Second Copy",
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
});
it.each(["user", "project"] as const)(
  "preserves %s session provenance and its untrimmed fallback name beside local loading",
  async (source) => {
    const root = tempDirs.make("openclaw-skill-materialization-");
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    const skillRoot =
      source === "user" ? path.join(agentDir, "skills") : path.join(cwd, ".openclaw", "skills");
    const skillDir = path.join(skillRoot, " padded-name");
    const filePath = await writeRawSkill(
      skillDir,
      '---\ndescription: "  Padded metadata.  "\ndisable-model-invocation: true\n---\n# Shared Title\n',
    );

    const session = loadSkills({ cwd, agentDir, skillPaths: [filePath] });
    const location = { path: filePath, baseDir: skillDir, origin: "top-level" };
    const expected = {
      name: " padded-name",
      displayName: "Shared Title",
      description: "Padded metadata.",
      contentHash: expect.any(String),
      filePath,
      baseDir: skillDir,
      disableModelInvocation: true,
      source,
      sourceInfo: { ...location, source: "local", scope: source },
    };
    expect(session.skills).toEqual([expected]);
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
      ...expected,
      name: "padded-name",
      contentHash: session.skills[0]!.contentHash,
      source: "workspace",
      sourceInfo: {
        ...location,
        source: "workspace",
        scope: "project",
      },
    });
    expect(diagnostics).toEqual([]);
  },
);

async function scanFixture(raw: string, directory = true) {
  const root = tempDirs.make("openclaw-skill-scan-");
  const file = await writeRawSkill(
    directory ? path.join(root, "skill") : root,
    raw,
    directory ? "SKILL.md" : "not-a-directory",
  );
  return { file, result: loadSkillsFromPath(directory ? root : file) };
}

it("reports non-directory scan input", async () => {
  const { file, result } = await scanFixture("not a skill directory", false);
  expect(result).toEqual({
    skills: [],
    diagnostics: [expect.objectContaining({ type: "warning", path: file })],
  });
});

it("does not load dash-prefixed Markdown as frontmatter", async () => {
  const { file, result } = await scanFixture(
    "----\nname: bogus\ndescription: must remain Markdown\n---\n# Body\n",
  );
  expect(result.skills).toEqual([]);
  expect(result.diagnostics).toContainEqual({
    type: "warning",
    message: "description is required",
    path: file,
  });
});

it("reports malformed frontmatter by file and keeps loading sibling skills", async () => {
  const tempDir = tempDirs.make("openclaw-skill-scan-");
  const brokenDir = path.join(tempDir, "broken");
  const brokenFile = await writeRawSkill(
    brokenDir,
    "---\nname: [broken\ndescription: Broken skill\n---\n",
  );
  await writeRawSkill(
    path.join(tempDir, "valid"),
    "---\nname: valid\ndescription: Valid sibling\n---\n",
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
