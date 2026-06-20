import fs from "node:fs/promises";
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
  ])("rejects existing workspace skill refs in %s", async (_label, content, expectedRef) => {
    const workspaceDir = await makeWorkspaceWithSkills(workspaceSkills);

    expect(() => assertCreateProposalDoesNotPatchExistingSkills({ workspaceDir, content })).toThrow(
      `action=create cannot propose changes to existing workspace skills: ${expectedRef}`,
    );
  });

  it.each([
    ["new skill path", "Add `skills/new-skill/SKILL.md`."],
    ["bare directory without child path", "This mentions skills/foo as prose."],
    ["non-workspace URL path", "See https://example.test/skills/foo/SKILL.md"],
    ["plain word prefix", "prefixskills/foo/SKILL.md"],
  ])("allows %s", async (_label, content) => {
    const workspaceDir = await makeWorkspaceWithSkills(workspaceSkills);

    expect(() =>
      assertCreateProposalDoesNotPatchExistingSkills({ workspaceDir, content }),
    ).not.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "rejects configured trusted symlink workspace skill refs",
    async () => {
      const workspaceDir = await tempDirs.make("openclaw-skill-workshop-symlink-root-");
      const targetSkillsDir = await tempDirs.make("openclaw-skill-workshop-symlink-skills-");
      await fs.symlink(targetSkillsDir, path.join(workspaceDir, "skills"), "dir");
      await writeSkill({
        dir: path.join(targetSkillsDir, "shared-skill"),
        name: "shared-skill",
        description: "Shared skill target",
        body: "# Shared Skill\n\nExisting workflow.\n",
      });
      const config = { skills: { load: { allowSymlinkTargets: [targetSkillsDir] } } };

      expect(() =>
        assertCreateProposalDoesNotPatchExistingSkills({
          workspaceDir,
          config,
          content: "Patch `skills/shared-skill/SKILL.md`.",
        }),
      ).toThrow(
        "action=create cannot propose changes to existing workspace skills: skills/shared-skill/",
      );
    },
  );
});
