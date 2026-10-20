import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { setTestEnvValue } from "../../test-utils/env.js";
import { refreshSkillsDiscovery } from "../runtime/refresh.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "../test-support/home-env.test-support.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

const tempDirs = createTempDirTracker();

function createWorkspaceSkillDirs(fakeHome: string) {
  const workspaceDir = tempDirs.make("openclaw-");
  const managedDir = path.join(workspaceDir, ".managed");
  return {
    managedDir,
    projectDir: path.join(workspaceDir, ".agents", "skills"),
    skillsDir: path.join(workspaceDir, "skills"),
    personalDir: path.join(fakeHome, ".agents", "skills"),
    prompt: async () =>
      (
        await buildSkillSnapshot(workspaceDir, {
          config: { plugins: { enabled: false } },
          managedSkillsDir: managedDir,
          bundledSkillsDir: path.join(workspaceDir, ".bundled"),
        })
      ).prompt,
    refresh: () => refreshSkillsDiscovery({ workspaceDir }),
  };
}

function writeNamedSkill(dir: string, description: string, name = "shared-skill") {
  return writeSkill({ dir: path.join(dir, name), name, description });
}

describe("buildWorkspaceSkillsPrompt — .agents/skills/ directories", () => {
  let fakeHome: string;
  let envSnapshot: SkillsHomeEnvSnapshot;

  beforeEach(async () => {
    fakeHome = tempDirs.make("openclaw-home-");
    envSnapshot = setMockSkillsHomeEnv(fakeHome);
  });

  afterEach(async () => {
    await restoreMockSkillsHomeEnv(envSnapshot, async () => {
      tempDirs.cleanup();
    });
  });

  it.each([
    ["projectDir", "Project agents version", "skillsDir", "Workspace version"],
    ["personalDir", "Personal agents version", "projectDir", "Project agents version"],
  ] as const)(
    "honors %s precedence before and after refresh",
    async (lower, lowerText, higher, higherText) => {
      const dirs = createWorkspaceSkillDirs(fakeHome);
      await writeNamedSkill(dirs.managedDir, "Managed version");
      await writeNamedSkill(dirs[lower], lowerText);
      const prompt1 = await dirs.prompt();
      expect(prompt1).toContain(lowerText);
      expect(prompt1).not.toContain("Managed version");

      await writeNamedSkill(dirs[higher], higherText);
      await dirs.refresh();
      const prompt2 = await dirs.prompt();
      expect(prompt2).toContain(higherText);
      expect(prompt2).not.toContain(lowerText);
    },
  );

  it("loads personal agent skills only for the default state directory", async () => {
    const dirs = createWorkspaceSkillDirs(fakeHome);
    await writeNamedSkill(dirs.personalDir, "Personal only skill", "personal-only");

    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(fakeHome, ".openclaw"));
    expect(await dirs.prompt()).toContain("personal-only");

    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(fakeHome, "scratch-state"));
    expect(await dirs.prompt()).not.toContain("personal-only");
  });

  it("loads unique skills from all .agents/skills/ sources alongside others", async () => {
    const dirs = createWorkspaceSkillDirs(fakeHome);
    await writeNamedSkill(dirs.managedDir, "Managed only skill", "managed-only");
    await writeNamedSkill(dirs.personalDir, "Personal only skill", "personal-only");
    await writeNamedSkill(dirs.projectDir, "Project only skill", "project-only");
    await writeNamedSkill(dirs.skillsDir, "Workspace only skill", "workspace-only");
    const prompt = await dirs.prompt();
    expect(prompt).toContain("managed-only");
    expect(prompt).toContain("personal-only");
    expect(prompt).toContain("project-only");
    expect(prompt).toContain("workspace-only");
  });
});
