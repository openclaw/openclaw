import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { installSkillFromSource } from "../lifecycle/source-install.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import {
  writeSkillFixture,
  useLoadingFixture,
  captureWarningLogger,
} from "./loading.test-support.js";
import { loadWorkspaceSkills } from "./workspace-skill-loader.js";

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
}));

const skill = (dir: string, name: string, description = name, body?: string) =>
  writeSkillFixture(dir, name, description, { body });
async function link(target: string, destination: string, type: "dir" | "file" = "dir") {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.symlink(target, destination, type);
  return destination;
}

const fixture = useLoadingFixture("openclaw-skills-skill-path-containment-", true);
let workspaceCaseIndex = 0;

const createTempWorkspaceDir = () => fixture.createDir();

async function writeHardlinkedSkill(params: { dir: string; name: string; description: string }) {
  const sourceDir = path.join(fixture.root, `hardlink-source-${++workspaceCaseIndex}`);
  await writeSkill({ ...params, dir: sourceDir });
  await fs.mkdir(params.dir, { recursive: true });
  const skillFilePath = path.join(params.dir, "SKILL.md");
  await fs.link(path.join(sourceDir, "SKILL.md"), skillFilePath);
  expect((await fs.stat(skillFilePath)).nlink).toBeGreaterThan(1);
}

function firstWarningLine(warn: ReturnType<typeof vi.fn>): string {
  const [line] = warn.mock.calls[0] ?? [];
  return String(line);
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

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

it("rejects hardlinked workspace skills while preserving ordinary files", async () => {
  const workspaceDir = await createTempWorkspaceDir();
  const skillRoot = path.join(workspaceDir, "skills");
  const rejectedSkillName = "workspace-hardlinked-skill";
  const acceptedSkillName = "workspace-ordinary-skill";
  await writeHardlinkedSkill({
    dir: path.join(skillRoot, rejectedSkillName),
    name: rejectedSkillName,
    description: "Untrusted workspace hardlink",
  });
  await skill(
    path.join(skillRoot, acceptedSkillName),
    acceptedSkillName,
    "Ordinary workspace skill",
  );
  const warn = captureWarningLogger();

  const entries = loadTestWorkspaceSkills(workspaceDir);

  expect(entries).toEqual([
    expect.objectContaining({
      skill: expect.objectContaining({ name: acceptedSkillName, source: "openclaw-workspace" }),
    }),
  ]);
  const warningLine = firstWarningLine(warn);
  expect(warningLine).toContain("Skipping invalid skill:");
  expect(warningLine).toContain(rejectedSkillName);
  expect(warningLine).toMatch(/hardlink/iu);
});

it.runIf(process.platform !== "win32")(
  "skips workspace skill paths that resolve outside the workspace root",
  async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const outsideDir = await createTempWorkspaceDir();
    const escapedSkillDir = path.join(outsideDir, "outside-skill");
    await skill(escapedSkillDir, "outside-skill", "Outside");
    const requestedPath = path.join(workspaceDir, "skills", "escaped-skill");
    await link(escapedSkillDir, requestedPath);
    const fileLinkSkillDir = path.join(workspaceDir, "skills", "escaped-file");
    await link(path.join(outsideDir, "SKILL.md"), path.join(fileLinkSkillDir, "SKILL.md"), "file");
    const targetDir = path.join(workspaceDir, "safe-target");
    await skill(targetDir, "symlink-target", "Target skill");
    const symlinkedSkillDir = path.join(workspaceDir, "skills", "symlinked");
    await link(path.join(targetDir, "SKILL.md"), path.join(symlinkedSkillDir, "SKILL.md"), "file");
    const warn = captureWarningLogger();

    const entries = loadTestWorkspaceSkills(workspaceDir);

    expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-skill");
    expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-file-skill");
    expect(entries.map((entry) => entry.skill.name)).not.toContain("symlink-target");
    const warningLine = firstWarningLine(warn);
    expect(warningLine).toContain("Skipping escaped skill path outside its configured root:");
    expect(warningLine).toContain("reason=symlink-escape");
    expect(warningLine).toContain("source=openclaw-workspace");
    expect(warningLine).toContain(`root=${path.join(workspaceDir, "skills")}`);
    expect(warningLine).toContain(`requested=${requestedPath}`);
    expect(warningLine).toContain("resolved=");
  },
);

function discoveredNames(
  workspaceDir: string,
  extraDirs: string[] = [],
  limits: NonNullable<import("../../config/types.openclaw.js").OpenClawConfig["skills"]> = {},
) {
  return loadTestWorkspaceSkills(workspaceDir, {
    config: { skills: { load: { extraDirs }, ...limits } },
  }).map((entry) => entry.skill.name);
}

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
      discoveredNames(workspaceDir, [], {
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
      discoveredNames(workspaceDir, [], {
        limits: { maxCandidatesPerRoot: 2, maxSkillsLoadedPerSource: 10 },
      }),
    ).toContain("later-skill");
  });

  it("keeps a configured direct skill root even when it has nested skill fixtures", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillDir = await createTempWorkspaceDir();
    await skill(skillDir, "direct-root", "Configured direct skill root");
    await skill(path.join(skillDir, "skills", "examples", "fixture"), "fixture-skill");
    const loaded = discoveredNames(workspaceDir, [skillDir]);
    expect(loaded).toContain("direct-root");
    expect(loaded).not.toContain("fixture-skill");
  });

  it("keeps nested skills when top-level candidate cap is filled by direct skills", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillRootDir = await createTempWorkspaceDir();
    await skill(path.join(skillRootDir, "00-valid"), "valid-root-skill");
    await skill(path.join(skillRootDir, "skills", "examples", "fixture"), "fixture-skill");
    const loaded = discoveredNames(workspaceDir, [skillRootDir], {
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
    const loaded = discoveredNames(workspaceDir, [skillRootDir]);
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

    const loaded = discoveredNames(workspaceDir, [], {
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
      discoveredNames(workspaceDir, [repoDir], {
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
    const loaded = discoveredNames(workspaceDir, [], { limits: { maxSkillFileBytes: 1000 } });
    expect(loaded).toContain("small-skill");
    expect(loaded).not.toContain("big-skill");
  });
});

it.runIf(process.platform !== "win32")(
  "rejects symlinked skills in the Workshop-owned directory",
  async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const config = {
      agents: { entries: { main: { agentDir: path.join(workspaceDir, ".agent") } } },
    };
    const workshopSkillsDir = resolveWorkshopSkillsDir(config, "main");
    const outsideDir = await createTempWorkspaceDir();
    const outsideSkillDir = path.join(outsideDir, "outside-workshop-skill");
    await skill(outsideSkillDir, "outside-workshop-skill", "Outside Workshop");
    await link(outsideSkillDir, path.join(workshopSkillsDir, "outside-workshop-skill"));
    const warn = captureWarningLogger();

    const entries = loadTestWorkspaceSkills(workspaceDir, { config, agentId: "main" });

    expect(entries).toEqual([]);
    expect(firstWarningLine(warn)).toContain("source=openclaw-workshop");
    expect(firstWarningLine(warn)).toContain("reason=symlink-escape");
  },
);

it.runIf(process.platform !== "win32")(
  "allows configured skill symlink targets outside their source root",
  async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillName = `manager-${++workspaceCaseIndex}`;
    const targetRoot = path.join(fixture.root, `${skillName}-skills`);
    const targetSkillDir = path.join(targetRoot, skillName);
    await skill(targetSkillDir, skillName, "Manager skill");
    const workspaceSkillsDir = path.join(workspaceDir, "skills");
    const symlinkPath = path.join(workspaceSkillsDir, skillName);
    await link(targetSkillDir, symlinkPath);
    const warn = captureWarningLogger();

    const entries = loadTestWorkspaceSkills(workspaceDir, {
      config: { skills: { load: { allowSymlinkTargets: [targetRoot] } } },
    });

    expect(entries.map((entry) => entry.skill.name)).toContain(skillName);
    expect(warn).not.toHaveBeenCalled();
  },
);

it.runIf(process.platform !== "win32")(
  "keeps SKILL.md containment for managed symlinked skill directories",
  async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const managedDir = path.join(workspaceDir, ".managed");
    const skillName = `managed-file-link-${++workspaceCaseIndex}`;
    const targetSkillDir = path.join(fixture.root, `${skillName}-target`, skillName);
    const outsideDir = path.join(fixture.root, `${skillName}-outside`);
    await skill(outsideDir, skillName, "Escaped metadata");
    await link(path.join(outsideDir, "SKILL.md"), path.join(targetSkillDir, "SKILL.md"), "file");
    const symlinkPath = path.join(managedDir, skillName);
    await link(targetSkillDir, symlinkPath);
    const warn = captureWarningLogger();

    const entries = loadTestWorkspaceSkills(workspaceDir, {
      managedSkillsDir: managedDir,
    });

    expect(entries.map((entry) => entry.skill.name)).not.toContain(skillName);
    const warningLine = firstWarningLine(warn);
    expect(warningLine).toContain("Skipping escaped skill path outside its configured root:");
    expect(warningLine).toContain("source=openclaw-managed");
    expect(warningLine).toContain("reason=symlink-escape");
  },
);

it.runIf(process.platform !== "win32")(
  "uses compact home-relative paths in escaped skill console warnings",
  async () => {
    const workspaceDir = path.join(fixture.home, "workspace");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const escaped = path.join(fixture.home, "outside", "outside-bundled-skill");
    await skill(escaped, "outside-bundled-skill");
    await link(escaped, path.join(bundledDir, "escaped-bundled-skill"));
    const warn = captureWarningLogger();

    expect(
      loadTestWorkspaceSkills(workspaceDir, {
        bundledSkillsDir: bundledDir,
      }),
    ).toEqual([]);

    const warningLine = firstWarningLine(warn);
    expect(warningLine).toContain("root=~/workspace/.bundled");
    expect(warningLine).toContain("requested=~/workspace/.bundled/escaped-bundled-skill");
    expect(warningLine).toContain("resolved=~/outside/outside-bundled-skill");
  },
);

it.runIf(process.platform !== "win32").each([false, true])(
  "discovers nested roots without following unapproved symlinks (allowed=%s)",
  async (allowed) => {
    const workspaceDir = await createTempWorkspaceDir();
    const repoDir = await createTempWorkspaceDir();
    const outsideDir = await createTempWorkspaceDir();
    const target = allowed ? path.join(outsideDir, "linked") : outsideDir;
    const name = allowed ? "linked-skill" : "outside-linked-skill";
    await skill(path.join(outsideDir, "linked"), name);
    await link(target, path.join(repoDir, allowed ? "group" : "examples", "linked"));
    await skill(path.join(repoDir, "skills", "group", "valid"), "repo-nested-skill");
    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: {
            extraDirs: [repoDir],
            ...(allowed ? { allowSymlinkTargets: [outsideDir] } : {}),
          },
        },
      },
    }).map((entry) => entry.skill.name);
    expect(names).toContain("repo-nested-skill");
    expect(names.includes(name)).toBe(allowed);
  },
);
