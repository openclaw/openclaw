import { existsSync } from "node:fs";
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
let caseIndex = 0;

const newDir = () => fixture.createDir();

async function writeHardlinkedSkill(params: { dir: string; name: string; description: string }) {
  const sourceDir = path.join(fixture.root, `hardlink-source-${++caseIndex}`);
  await writeSkill({ ...params, dir: sourceDir });
  await fs.mkdir(params.dir, { recursive: true });
  const skillFilePath = path.join(params.dir, "SKILL.md");
  await fs.link(path.join(sourceDir, "SKILL.md"), skillFilePath);
  expect((await fs.stat(skillFilePath)).nlink).toBeGreaterThan(1);
}

function warningLine(warn: ReturnType<typeof vi.fn>): string {
  const [line] = warn.mock.calls[0] ?? [];
  return String(line);
}

function load(workspace: string, opts?: Parameters<typeof loadWorkspaceSkills>[1]) {
  return loadWorkspaceSkills(workspace, {
    managedSkillsDir: path.join(workspace, ".managed"),
    bundledSkillsDir: "",
    pluginSkillsDir: path.join(workspace, ".plugin-skills"),
    ...opts,
  });
}

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

it("loads skills when the workspace path has different casing on disk", async ({ skip }) => {
  const workspace = await fixture.createDir("CaseWorkspace");
  const configuredWorkspace = path.join(
    path.dirname(workspace),
    path.basename(workspace).toLowerCase(),
  );
  if (!existsSync(configuredWorkspace)) {
    skip("Requires a case-insensitive filesystem");
  }
  await skill(path.join(workspace, "skills", "case-skill"), "case-skill");
  const warn = captureWarningLogger();

  const entries = load(configuredWorkspace);

  expect(warn).not.toHaveBeenCalled();
  expect(entries.map((entry) => entry.skill.name)).toEqual(["case-skill"]);
});

it("rejects hardlinked workspace skills while preserving ordinary files", async () => {
  const workspace = await newDir();
  const skillRoot = path.join(workspace, "skills");
  const rejected = "workspace-hardlinked-skill";
  const accepted = "workspace-ordinary-skill";
  await writeHardlinkedSkill({
    dir: path.join(skillRoot, rejected),
    name: rejected,
    description: "Untrusted workspace hardlink",
  });
  await skill(path.join(skillRoot, accepted), accepted, "Ordinary workspace skill");
  const warn = captureWarningLogger();

  const entries = load(workspace);

  expect(entries).toEqual([
    expect.objectContaining({
      skill: expect.objectContaining({ name: accepted, source: "openclaw-workspace" }),
    }),
  ]);
  const warning = warningLine(warn);
  expect(warning).toContain("Skipping invalid skill:");
  expect(warning).toContain(rejected);
  expect(warning).toMatch(/hardlink/iu);
});

function discoveredNames(
  workspace: string,
  extraDirs: string[] = [],
  limits: NonNullable<import("../../config/types.openclaw.js").OpenClawConfig["skills"]> = {},
) {
  return load(workspace, {
    config: { skills: { load: { extraDirs }, ...limits } },
  }).map((entry) => entry.skill.name);
}

describe("discoverSkillCandidates", () => {
  it("rejects an undiscoverable replacement without removing the installed skill", async () => {
    const workspace = await newDir();
    const sourceDir = await newDir();
    await skill(sourceDir, "installed-skill", "Keep the discoverable installation");
    expect(
      await installSkillFromSource({
        workspaceDir: workspace,
        spec: sourceDir,
        slug: "installed-skill",
      }),
    ).toMatchObject({ slug: "installed-skill" });
    await fs.writeFile(path.join(sourceDir, "SKILL.md"), "---\nname: installed-skill\n---\n");

    await expect(
      installSkillFromSource({
        workspaceDir: workspace,
        spec: sourceDir,
        slug: "installed-skill",
        force: true,
      }),
    ).rejects.toThrow("description is required");
    expect(load(workspace).map((entry) => entry.skill.description)).toEqual([
      "Keep the discoverable installation",
    ]);
  });

  it("loads earlier grouped skills before later direct siblings hit the source cap", async () => {
    const workspace = await newDir();
    await skill(path.join(workspace, "skills", "00-group", "grouped"), "grouped-skill");
    await skill(path.join(workspace, "skills", "01-direct"), "direct-skill");
    expect(
      discoveredNames(workspace, [], {
        limits: { maxCandidatesPerRoot: 10, maxSkillsLoadedPerSource: 1 },
      }),
    ).toEqual(["grouped-skill"]);
  });

  it("keeps later grouped siblings discoverable when an earlier group is noisy", async () => {
    const workspace = await newDir();
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
    await createNoisyTree(path.join(workspace, "skills", "00-noisy"), 6);
    await skill(path.join(workspace, "skills", "01-later", "later-skill"), "later-skill");
    expect(
      discoveredNames(workspace, [], {
        limits: { maxCandidatesPerRoot: 2, maxSkillsLoadedPerSource: 10 },
      }),
    ).toContain("later-skill");
  });

  it("keeps a configured direct skill root even when it has nested skill fixtures", async () => {
    const workspace = await newDir();
    const skillDir = await newDir();
    await skill(skillDir, "direct-root", "Configured direct skill root");
    await skill(path.join(skillDir, "skills", "examples", "fixture"), "fixture-skill");
    const loaded = discoveredNames(workspace, [skillDir]);
    expect(loaded).toContain("direct-root");
    expect(loaded).not.toContain("fixture-skill");
  });

  it("keeps nested skills when top-level candidate cap is filled by direct skills", async () => {
    const workspace = await newDir();
    const root = await newDir();
    await skill(path.join(root, "00-valid"), "valid-root-skill");
    await skill(path.join(root, "skills", "examples", "fixture"), "fixture-skill");
    const loaded = discoveredNames(workspace, [root], {
      limits: { maxCandidatesPerRoot: 1, maxSkillsLoadedPerSource: 10 },
    });
    expect(loaded).toContain("valid-root-skill");
    expect(loaded).toContain("fixture-skill");
  });

  it("keeps configured root grouping outside skills within watcher depth", async () => {
    const workspace = await newDir();
    const root = await newDir();
    await skill(path.join(root, "group", "within-depth"), "within-depth");
    await skill(path.join(root, "group", "d1", "too-deep"), "too-deep");
    await skill(path.join(root, "skills", "d0", "d1", "d2", "d3", "d4", "d5"), "deep-nested-skill");
    const loaded = discoveredNames(workspace, [root]);
    expect(loaded).toContain("within-depth");
    expect(loaded).toContain("deep-nested-skill");
    expect(loaded).not.toContain("too-deep");
  });

  it("does not spend nested candidate budget on ignored raw entries", async () => {
    const workspace = await newDir();
    const groupDir = path.join(workspace, "skills", "group");
    await fs.mkdir(groupDir, { recursive: true });
    for (let i = 0; i < 50; i += 1) {
      await fs.writeFile(path.join(groupDir, `ignored-${String(i).padStart(2, "0")}.txt`), "");
    }
    for (const name of ["valid-a", "valid-b", "valid-c"]) {
      await skill(path.join(groupDir, name), name, `${name} nested under a group`);
    }

    const loaded = discoveredNames(workspace, [], {
      limits: { maxCandidatesPerRoot: 2, maxSkillsLoadedPerSource: 10 },
    });
    expect(loaded.filter((name) => name.startsWith("valid-"))).toEqual(["valid-a", "valid-b"]);
  });

  it("limits discovery for nested repo-style skills roots (dir/skills/*)", async () => {
    const workspace = await newDir();
    const repoDir = await newDir();
    for (let i = 0; i < 8; i += 1) {
      const name = `repo-skill-${String(i).padStart(2, "0")}`;
      await skill(path.join(repoDir, "skills", name), name, `Desc ${i}`);
    }

    expect(
      discoveredNames(workspace, [repoDir], {
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
    const workspace = await newDir();
    await skill(path.join(workspace, "skills", "small-skill"), "small-skill", "Small");
    await skill(path.join(workspace, "skills", "big-skill"), "big-skill", "Big", "x".repeat(5_000));
    const loaded = discoveredNames(workspace, [], { limits: { maxSkillFileBytes: 1000 } });
    expect(loaded).toContain("small-skill");
    expect(loaded).not.toContain("big-skill");
  });
});

describe.runIf(process.platform !== "win32")("symlink containment", () => {
  it("skips workspace skill paths that resolve outside the workspace root", async () => {
    const workspace = await newDir();
    const outside = await newDir();
    const escapedSkillDir = path.join(outside, "outside-skill");
    await skill(escapedSkillDir, "outside-skill", "Outside");
    const requested = path.join(workspace, "skills", "escaped-skill");
    await link(escapedSkillDir, requested);
    const fileLink = path.join(workspace, "skills", "escaped-file");
    await link(path.join(outside, "SKILL.md"), path.join(fileLink, "SKILL.md"), "file");
    const targetDir = path.join(workspace, "safe-target");
    await skill(targetDir, "symlink-target", "Target skill");
    const linked = path.join(workspace, "skills", "symlinked");
    await link(path.join(targetDir, "SKILL.md"), path.join(linked, "SKILL.md"), "file");
    const warn = captureWarningLogger();

    const entries = load(workspace);

    expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-skill");
    expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-file-skill");
    expect(entries.map((entry) => entry.skill.name)).not.toContain("symlink-target");
    const warning = warningLine(warn);
    expect(warning).toContain("Skipping escaped skill path outside its configured root:");
    expect(warning).toContain("reason=symlink-escape");
    expect(warning).toContain("source=openclaw-workspace");
    expect(warning).toContain(`root=${path.join(workspace, "skills")}`);
    expect(warning).toContain(`requested=${requested}`);
    expect(warning).toContain("resolved=");
  });

  it("rejects symlinked skills in the Workshop-owned directory", async () => {
    const workspace = await newDir();
    const config = {
      agents: { entries: { main: { agentDir: path.join(workspace, ".agent") } } },
    };
    const workshop = resolveWorkshopSkillsDir(config, "main");
    const outside = await newDir();
    const outsideSkillDir = path.join(outside, "outside-workshop-skill");
    await skill(outsideSkillDir, "outside-workshop-skill", "Outside Workshop");
    await link(outsideSkillDir, path.join(workshop, "outside-workshop-skill"));
    const warn = captureWarningLogger();

    const entries = load(workspace, { config, agentId: "main" });

    expect(entries).toEqual([]);
    expect(warningLine(warn)).toContain("source=openclaw-workshop");
    expect(warningLine(warn)).toContain("reason=symlink-escape");
  });

  it("allows configured skill symlink targets outside their source root", async () => {
    const workspace = await newDir();
    const skillName = `manager-${++caseIndex}`;
    const targetRoot = path.join(fixture.root, `${skillName}-skills`);
    const target = path.join(targetRoot, skillName);
    await skill(target, skillName, "Manager skill");
    const workspaceSkillsDir = path.join(workspace, "skills");
    const symlinkPath = path.join(workspaceSkillsDir, skillName);
    await link(target, symlinkPath);
    const warn = captureWarningLogger();

    const entries = load(workspace, {
      config: { skills: { load: { allowSymlinkTargets: [targetRoot] } } },
    });

    expect(entries.map((entry) => entry.skill.name)).toContain(skillName);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps SKILL.md containment for managed symlinked skill directories", async () => {
    const workspace = await newDir();
    const managed = path.join(workspace, ".managed");
    const skillName = `managed-file-link-${++caseIndex}`;
    const target = path.join(fixture.root, `${skillName}-target`, skillName);
    const outside = path.join(fixture.root, `${skillName}-outside`);
    await skill(outside, skillName, "Escaped metadata");
    await link(path.join(outside, "SKILL.md"), path.join(target, "SKILL.md"), "file");
    const symlinkPath = path.join(managed, skillName);
    await link(target, symlinkPath);
    const warn = captureWarningLogger();

    const entries = load(workspace, {
      managedSkillsDir: managed,
    });

    expect(entries.map((entry) => entry.skill.name)).not.toContain(skillName);
    const warning = warningLine(warn);
    expect(warning).toContain("Skipping escaped skill path outside its configured root:");
    expect(warning).toContain("source=openclaw-managed");
    expect(warning).toContain("reason=symlink-escape");
  });

  it("uses compact home-relative paths in escaped skill console warnings", async () => {
    const workspace = path.join(fixture.home, "workspace");
    const bundledDir = path.join(workspace, ".bundled");
    const escaped = path.join(fixture.home, "outside", "outside-bundled-skill");
    await skill(escaped, "outside-bundled-skill");
    await link(escaped, path.join(bundledDir, "escaped-bundled-skill"));
    const warn = captureWarningLogger();

    expect(
      load(workspace, {
        bundledSkillsDir: bundledDir,
      }),
    ).toEqual([]);

    const warning = warningLine(warn);
    expect(warning).toContain("root=~/workspace/.bundled");
    expect(warning).toContain("requested=~/workspace/.bundled/escaped-bundled-skill");
    expect(warning).toContain("resolved=~/outside/outside-bundled-skill");
  });

  it.each([false, true])(
    "discovers nested roots without following unapproved symlinks (allowed=%s)",
    async (allowed) => {
      const workspace = await newDir();
      const repoDir = await newDir();
      const outside = await newDir();
      const target = allowed ? path.join(outside, "linked") : outside;
      const name = allowed ? "linked-skill" : "outside-linked-skill";
      await skill(path.join(outside, "linked"), name);
      await link(target, path.join(repoDir, allowed ? "group" : "examples", "linked"));
      await skill(path.join(repoDir, "skills", "group", "valid"), "repo-nested-skill");
      const names = load(workspace, {
        config: {
          skills: {
            load: {
              extraDirs: [repoDir],
              ...(allowed ? { allowSymlinkTargets: [outside] } : {}),
            },
          },
        },
      }).map((entry) => entry.skill.name);
      expect(names).toContain("repo-nested-skill");
      expect(names.includes(name)).toBe(allowed);
    },
  );
});
