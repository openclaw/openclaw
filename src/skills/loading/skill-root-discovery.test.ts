// Skill root discovery tests cover bounded recursive scanning and nested repo-style roots.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installSkillFromSource } from "../lifecycle/source-install.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { loadWorkspaceSkills } from "./workspace-skill-loader.js";

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
}));

let tempRoot = "";
let workspaceCaseIndex = 0;

async function createTempWorkspaceDir() {
  const workspaceDir = path.join(tempRoot, `workspace-${++workspaceCaseIndex}`);
  await fs.mkdir(workspaceDir, { recursive: true });
  return workspaceDir;
}

const skill = (dir: string, name: string, description = name, body?: string) =>
  writeSkill({ dir, name, description, body });

function loadTestWorkspaceSkills(
  workspaceDir: string,
  opts?: Parameters<typeof loadWorkspaceSkills>[1],
) {
  return loadWorkspaceSkills(workspaceDir, {
    managedSkillsDir: path.join(workspaceDir, ".managed"),
    bundledSkillsDir: "",
    pluginSkillsDir: path.join(workspaceDir, ".plugin-skills"),
    ...opts,
  });
}

function names(
  workspaceDir: string,
  extraDirs: string[] = [],
  limits: NonNullable<import("../../config/types.openclaw.js").OpenClawConfig["skills"]> = {},
) {
  return loadTestWorkspaceSkills(workspaceDir, {
    config: { skills: { load: { extraDirs }, ...limits } },
  }).map((entry) => entry.skill.name);
}

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-discovery-"));
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("discoverSkillCandidates", () => {
  it("rejects an undiscoverable replacement without removing the installed skill", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const sourceDir = await createTempWorkspaceDir();
    await skill(sourceDir, "installed-skill", "Keep the discoverable installation");
    expect(
      await installSkillFromSource({ workspaceDir, spec: sourceDir, slug: "installed-skill" }),
    ).toMatchObject({ slug: "installed-skill" });
    await fs.writeFile(path.join(sourceDir, "SKILL.md"), "---\nname: installed-skill\n---\n");

    await expect(
      installSkillFromSource({
        workspaceDir,
        spec: sourceDir,
        slug: "installed-skill",
        force: true,
      }),
    ).rejects.toThrow("description is required");
    expect(loadTestWorkspaceSkills(workspaceDir).map((entry) => entry.skill.description)).toEqual([
      "Keep the discoverable installation",
    ]);
  });

  it("loads earlier grouped skills before later direct siblings hit the source cap", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await skill(path.join(workspaceDir, "skills", "00-group", "grouped"), "grouped-skill");
    await skill(path.join(workspaceDir, "skills", "01-direct"), "direct-skill");
    expect(
      names(workspaceDir, [], {
        limits: { maxCandidatesPerRoot: 10, maxSkillsLoadedPerSource: 1 },
      }),
    ).toEqual(["grouped-skill"]);
  });

  it("keeps later grouped siblings discoverable when an earlier group is noisy", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    async function createNoisyTree(dir: string, depth: number): Promise<void> {
      if (depth === 0) {
        return;
      }
      for (const name of ["00-a", "01-b"]) {
        const childDir = path.join(dir, name);
        await fs.mkdir(childDir, { recursive: true });
        await createNoisyTree(childDir, depth - 1);
      }
    }
    await createNoisyTree(path.join(workspaceDir, "skills", "00-noisy"), 6);
    await skill(path.join(workspaceDir, "skills", "01-later", "later-skill"), "later-skill");
    expect(
      names(workspaceDir, [], {
        limits: { maxCandidatesPerRoot: 2, maxSkillsLoadedPerSource: 10 },
      }),
    ).toContain("later-skill");
  });

  it("keeps a configured direct skill root even when it has nested skill fixtures", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillDir = await createTempWorkspaceDir();
    await skill(skillDir, "direct-root", "Configured direct skill root");
    await skill(path.join(skillDir, "skills", "examples", "fixture"), "fixture-skill");
    const loaded = names(workspaceDir, [skillDir]);
    expect(loaded).toContain("direct-root");
    expect(loaded).not.toContain("fixture-skill");
  });

  it("keeps nested skills when top-level candidate cap is filled by direct skills", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillRootDir = await createTempWorkspaceDir();
    await skill(path.join(skillRootDir, "00-valid"), "valid-root-skill");
    await skill(path.join(skillRootDir, "skills", "examples", "fixture"), "fixture-skill");
    const loaded = names(workspaceDir, [skillRootDir], {
      limits: { maxCandidatesPerRoot: 1, maxSkillsLoadedPerSource: 10 },
    });
    expect(loaded).toContain("valid-root-skill");
    expect(loaded).toContain("fixture-skill");
  });

  it("keeps configured root grouping outside skills within watcher depth", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillRootDir = await createTempWorkspaceDir();
    await skill(path.join(skillRootDir, "group", "within-depth"), "within-depth");
    await skill(path.join(skillRootDir, "group", "d1", "too-deep"), "too-deep");
    await skill(
      path.join(skillRootDir, "skills", "d0", "d1", "d2", "d3", "d4", "d5"),
      "deep-nested-skill",
    );
    const loaded = names(workspaceDir, [skillRootDir]);
    expect(loaded).toContain("within-depth");
    expect(loaded).toContain("deep-nested-skill");
    expect(loaded).not.toContain("too-deep");
  });

  it("does not spend nested candidate budget on ignored raw entries", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const groupDir = path.join(workspaceDir, "skills", "group");
    await fs.mkdir(groupDir, { recursive: true });
    for (let i = 0; i < 50; i += 1) {
      await fs.writeFile(path.join(groupDir, `ignored-${String(i).padStart(2, "0")}.txt`), "");
    }
    for (const name of ["valid-a", "valid-b", "valid-c"]) {
      await skill(path.join(groupDir, name), name, `${name} nested under a group`);
    }

    const loaded = names(workspaceDir, [], {
      limits: { maxCandidatesPerRoot: 2, maxSkillsLoadedPerSource: 10 },
    });
    expect(loaded.filter((name) => name.startsWith("valid-"))).toEqual(["valid-a", "valid-b"]);
  });

  it("limits discovery for nested repo-style skills roots (dir/skills/*)", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const repoDir = await createTempWorkspaceDir();
    for (let i = 0; i < 8; i += 1) {
      const name = `repo-skill-${String(i).padStart(2, "0")}`;
      await skill(path.join(repoDir, "skills", name), name, `Desc ${i}`);
    }

    expect(
      names(workspaceDir, [repoDir], {
        limits: { maxCandidatesPerRoot: 5, maxSkillsLoadedPerSource: 5 },
      }),
    ).toStrictEqual([
      "repo-skill-00",
      "repo-skill-01",
      "repo-skill-02",
      "repo-skill-03",
      "repo-skill-04",
    ]);
  });

  it("skips skills whose SKILL.md exceeds maxSkillFileBytes", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await skill(path.join(workspaceDir, "skills", "small-skill"), "small-skill", "Small");
    await skill(
      path.join(workspaceDir, "skills", "big-skill"),
      "big-skill",
      "Big",
      "x".repeat(5_000),
    );
    const loaded = names(workspaceDir, [], { limits: { maxSkillFileBytes: 1000 } });
    expect(loaded).toContain("small-skill");
    expect(loaded).not.toContain("big-skill");
  });
});
