import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { assertCreateProposalDoesNotPatchExistingSkills } from "./create-target-guard.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

type WorkspaceSkillFixture = {
  name: string;
  relativeDir: string;
};

async function makeWorkspaceWithSkills(skills: readonly WorkspaceSkillFixture[]): Promise<string> {
  const workspaceDir = await tempDirs.make("openclaw-skill-workshop-create-target-");
  for (const skill of skills) {
    await writeSkill({
      dir: path.join(workspaceDir, "skills", ...skill.relativeDir.split("/")),
      name: skill.name,
      description: `Existing ${skill.name} skill`,
      body: `# ${skill.name}\n\nExisting workflow.\n`,
    });
  }
  return workspaceDir;
}

const workspaceSkills = [
  { name: "foo", relativeDir: "foo" },
  { name: "foo_bar", relativeDir: "foo_bar" },
  { name: "foo-bar", relativeDir: "foo-bar" },
  { name: "nested-skill", relativeDir: "group/nested-skill" },
] satisfies WorkspaceSkillFixture[];

describe("assertCreateProposalDoesNotPatchExistingSkills", () => {
  it.each([
    ["inline code", "Change `skills/foo/SKILL.md`.", "skills/foo/"],
    ["quoted support path", '"skills/foo/scripts/helper.js"', "skills/foo/"],
    ["relative path", "Review ./skills/foo/references/example.md", "skills/foo/"],
    ["non-canonical directory", "Change `skills/foo_bar/SKILL.md`.", "skills/foo_bar/"],
    [
      "nested skill path",
      "Patch `skills/group/nested-skill/SKILL.md`.",
      "skills/group/nested-skill/",
    ],
    [
      "nested support path",
      '"skills/group/nested-skill/scripts/helper.js"',
      "skills/group/nested-skill/",
    ],
    [
      "deduped normalized path",
      "`skills/Foo_Bar/SKILL.md` and `skills/foo-bar/scripts/a.js`",
      "skills/foo-bar/",
    ],
    [
      "unified diff paths",
      "diff --git a/skills/foo/SKILL.md b/skills/foo/SKILL.md\n" +
        "--- a/skills/foo/SKILL.md\n" +
        "+++ b/skills/foo/SKILL.md\n",
      "skills/foo/",
    ],
    ["Windows-style relative path", "Change `skills\\foo\\SKILL.md`.", "skills/foo/"],
  ])("rejects existing workspace skill refs in %s", async (_label, content, expectedRef) => {
    const workspaceDir = await makeWorkspaceWithSkills(workspaceSkills);

    expect(() => assertCreateProposalDoesNotPatchExistingSkills({ workspaceDir, content })).toThrow(
      `action=create cannot propose changes to existing workspace skills: ${expectedRef}`,
    );
  });

  it("rejects prompted absolute and home-relative existing workspace skill refs", async () => {
    const homeDir = await tempDirs.make("openclaw-skill-workshop-create-target-home-");
    const workspaceDir = path.join(homeDir, "workspace");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "foo"),
      name: "foo",
      description: "Existing Foo skill",
      body: "# Foo\n\nExisting workflow.\n",
    });
    const absoluteSkillFile = path.join(workspaceDir, "skills", "foo", "SKILL.md");

    expect(() =>
      assertCreateProposalDoesNotPatchExistingSkills({
        workspaceDir,
        content: `<location>${absoluteSkillFile}</location>`,
      }),
    ).toThrow("action=create cannot propose changes to existing workspace skills: skills/foo/");

    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      expect(() =>
        assertCreateProposalDoesNotPatchExistingSkills({
          workspaceDir,
          content: "Change `~/workspace/skills/foo/SKILL.md`.",
        }),
      ).toThrow("action=create cannot propose changes to existing workspace skills: skills/foo/");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("rejects existing project agent skill refs", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-create-target-agents-");
    await writeSkill({
      dir: path.join(workspaceDir, ".agents", "skills", "project-reviewer"),
      name: "project-reviewer",
      description: "Existing project reviewer skill",
      body: "# Project Reviewer\n\nExisting workflow.\n",
    });

    expect(() =>
      assertCreateProposalDoesNotPatchExistingSkills({
        workspaceDir,
        content: "Patch `.agents/skills/project-reviewer/SKILL.md`.",
      }),
    ).toThrow(
      "action=create cannot propose changes to existing workspace skills: .agents/skills/project-reviewer/",
    );
  });

  it("rejects prompted absolute paths with native Windows separators", async () => {
    const workspaceDir = await makeWorkspaceWithSkills(workspaceSkills);
    const absoluteSkillFile = path
      .join(workspaceDir, "skills", "foo", "SKILL.md")
      .split(path.sep)
      .join("\\");

    expect(() =>
      assertCreateProposalDoesNotPatchExistingSkills({
        workspaceDir,
        content: `<location>${absoluteSkillFile}</location>`,
      }),
    ).toThrow("action=create cannot propose changes to existing workspace skills: skills/foo/");
  });

  it.each([
    ["new skill path", "Add `skills/new-skill/SKILL.md`."],
    ["bare directory without child path", "This mentions skills/foo as prose."],
    ["non-workspace absolute path", "Change `/tmp/other/skills/foo/SKILL.md`."],
    ["non-workspace URL path", "See https://example.test/skills/foo/SKILL.md"],
    ["plain word prefix", "prefixskills/foo/SKILL.md"],
  ])("allows %s", async (_label, content) => {
    const workspaceDir = await makeWorkspaceWithSkills(workspaceSkills);

    expect(() =>
      assertCreateProposalDoesNotPatchExistingSkills({ workspaceDir, content }),
    ).not.toThrow();
  });
});
