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

function collectMatching<T>(items: readonly T[], predicate: (item: T) => boolean): T[] {
  const matches: T[] = [];
  for (const item of items) {
    if (predicate(item)) {
      matches.push(item);
    }
  }
  return matches;
}

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
    await writeSkill({
      dir: sourceDir,
      name: "installed-skill",
      description: "Keep the discoverable installation",
    });
    expect(
      await installSkillFromSource({ workspaceDir, spec: sourceDir, slug: "installed-skill" }),
    ).toMatchObject({ ok: true });
    await fs.writeFile(path.join(sourceDir, "SKILL.md"), "---\nname: installed-skill\n---\n");

    expect(
      await installSkillFromSource({
        workspaceDir,
        spec: sourceDir,
        slug: "installed-skill",
        force: true,
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("description is required") });
    expect(loadTestWorkspaceSkills(workspaceDir).map((entry) => entry.skill.description)).toEqual([
      "Keep the discoverable installation",
    ]);
  });

  it("loads earlier grouped skills before later direct siblings hit the source cap", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "00-group", "grouped"),
      name: "grouped-skill",
      description: "Grouped skill before direct siblings",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "01-direct"),
      name: "direct-skill",
      description: "Direct sibling after grouped skill",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          limits: {
            maxCandidatesPerRoot: 10,
            maxSkillsLoadedPerSource: 1,
          },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toEqual(["grouped-skill"]);
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
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "01-later", "later-skill"),
      name: "later-skill",
      description: "Grouped sibling after a noisy tree",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          limits: {
            maxCandidatesPerRoot: 2,
            maxSkillsLoadedPerSource: 10,
          },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("later-skill");
  });

  it("keeps a configured direct skill root even when it has nested skill fixtures", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: skillDir,
      name: "direct-root",
      description: "Configured direct skill root",
    });
    await writeSkill({
      dir: path.join(skillDir, "skills", "examples", "fixture"),
      name: "fixture-skill",
      description: "Nested fixture skill should not replace the root",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [skillDir] },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("direct-root");
    expect(names).not.toContain("fixture-skill");
  });

  it("keeps nested skills when top-level candidate cap is filled by direct skills", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillRootDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(skillRootDir, "00-valid"),
      name: "valid-root-skill",
      description: "Direct child skill under configured root",
    });
    await writeSkill({
      dir: path.join(skillRootDir, "skills", "examples", "fixture"),
      name: "fixture-skill",
      description: "Nested fixture should still be scanned",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [skillRootDir] },
          limits: {
            maxCandidatesPerRoot: 1,
            maxSkillsLoadedPerSource: 10,
          },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("valid-root-skill");
    expect(names).toContain("fixture-skill");
  });

  it("keeps configured root grouping outside skills within watcher depth", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillRootDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(skillRootDir, "group", "within-depth"),
      name: "within-depth",
      description: "Depth 2 from configured root",
    });
    await writeSkill({
      dir: path.join(skillRootDir, "group", "d1", "too-deep"),
      name: "too-deep",
      description: "Depth 3 from configured root",
    });
    await writeSkill({
      dir: path.join(skillRootDir, "skills", "d0", "d1", "d2", "d3", "d4", "d5"),
      name: "deep-nested-skill",
      description: "Depth 6 from nested skills root",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [skillRootDir] },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("within-depth");
    expect(names).toContain("deep-nested-skill");
    expect(names).not.toContain("too-deep");
  });

  it("does not spend nested candidate budget on ignored raw entries", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const groupDir = path.join(workspaceDir, "skills", "group");
    await fs.mkdir(groupDir, { recursive: true });
    for (let i = 0; i < 50; i += 1) {
      await fs.writeFile(path.join(groupDir, `ignored-${String(i).padStart(2, "0")}.txt`), "");
    }
    for (const name of ["valid-a", "valid-b", "valid-c"]) {
      await writeSkill({
        dir: path.join(groupDir, name),
        name,
        description: `${name} nested under a group`,
      });
    }

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          limits: {
            maxCandidatesPerRoot: 2,
            maxSkillsLoadedPerSource: 10,
          },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(collectMatching(names, (name) => name.startsWith("valid-"))).toEqual([
      "valid-a",
      "valid-b",
    ]);
  });

  it("limits discovery for nested repo-style skills roots (dir/skills/*)", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const repoDir = await createTempWorkspaceDir();
    for (let i = 0; i < 8; i += 1) {
      const name = `repo-skill-${String(i).padStart(2, "0")}`;
      await writeSkill({
        dir: path.join(repoDir, "skills", name),
        name,
        description: `Desc ${i}`,
      });
    }

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [repoDir] },
          limits: {
            maxCandidatesPerRoot: 5,
            maxSkillsLoadedPerSource: 5,
          },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toStrictEqual([
      "repo-skill-00",
      "repo-skill-01",
      "repo-skill-02",
      "repo-skill-03",
      "repo-skill-04",
    ]);
  });

  it("skips skills whose SKILL.md exceeds maxSkillFileBytes", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "small-skill"),
      name: "small-skill",
      description: "Small",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "big-skill"),
      name: "big-skill",
      description: "Big",
      body: "x".repeat(5_000),
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: { skills: { limits: { maxSkillFileBytes: 1000 } } },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("small-skill");
    expect(names).not.toContain("big-skill");
  });
});
