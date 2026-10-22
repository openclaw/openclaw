import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createNestedGitEnv } from "../../../test/helpers/temp-repo.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { nodeFilePath } from "../../test-utils/node-file-path.js";
import { getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { refreshSkillsDiscovery } from "../runtime/refresh.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../runtime/session-snapshot.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { writePluginWithSkill } from "../test-support/skill-plugin-fixtures.test-support.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";
import { syncWorkspaceSkills } from "./workspace-skill-sync.runtime.js";

const isolatedConfig = { plugins: { enabled: false } } satisfies OpenClawConfig;

function sourceOptions(workspace: string) {
  return {
    config: isolatedConfig,
    bundledSkillsDir: path.join(workspace, ".bundled"),
    managedSkillsDir: path.join(workspace, ".managed"),
  };
}

function writeTestSkill(dir: string, name: string, description: string) {
  return writeSkill({ dir, name, description });
}

const skillPath = (workspace: string, ...parts: string[]) =>
  path.join(workspace, "skills", ...parts);
const readText = (...parts: string[]) => fs.readFile(path.join(...parts), "utf8");

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

let fixtureRoot = "";
let fixtureCount = 0;
let syncSourceTemplateDir = "";

async function createCaseDir(prefix: string): Promise<string> {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function syncSourceSkillsToTarget(sourceWorkspace: string, targetWorkspace: string) {
  await syncWorkspaceSkills(syncOptions(sourceWorkspace, targetWorkspace));
}

function syncOptions(sourceWorkspace: string, targetWorkspace: string) {
  return {
    ...sourceOptions(sourceWorkspace),
    sourceWorkspaceDir: sourceWorkspace,
    targetWorkspaceDir: targetWorkspace,
  };
}

function buildSnapshot(workspaceDir: string, opts?: Parameters<typeof buildSkillSnapshot>[1]) {
  return buildSkillSnapshot(workspaceDir, {
    ...sourceOptions(workspaceDir),
    snapshotVersion: getSkillsSnapshotVersion(workspaceDir),
    ...opts,
  });
}

beforeAll(async () => {
  fixtureRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-sync-suite-")),
  );
  syncSourceTemplateDir = await createCaseDir("source-template");
  for (const [dir, label] of [
    [".extra", "Extra"],
    [".bundled", "Bundled"],
    [".managed", "Managed"],
    ["skills", "Workspace"],
  ] as const) {
    await writeTestSkill(
      path.join(syncSourceTemplateDir, dir, "demo-skill"),
      "demo-skill",
      `${label} version`,
    );
  }
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("syncWorkspaceSkills", () => {
  const buildPrompt = async (
    workspaceDir: string,
    opts?: Parameters<typeof buildSkillSnapshot>[1],
  ) =>
    await withEnvAsync(
      { HOME: workspaceDir },
      async () =>
        (await buildSkillSnapshot(workspaceDir, { ...sourceOptions(workspaceDir), ...opts }))
          .prompt,
    );

  const cloneSourceTemplate = async () => {
    const sourceWorkspace = await createCaseDir("source");
    await fs.cp(syncSourceTemplateDir, sourceWorkspace, { recursive: true });
    return sourceWorkspace;
  };

  it("syncs merged skills into a target workspace", async () => {
    const sourceWorkspace = await cloneSourceTemplate();
    const targetWorkspace = await createCaseDir("target");
    const workspaceSkillDir = skillPath(sourceWorkspace, "demo-skill");

    await fs.mkdir(path.join(workspaceSkillDir, ".git"), { recursive: true });
    await fs.writeFile(path.join(workspaceSkillDir, ".git", "config"), "gitdir");
    await fs.mkdir(path.join(workspaceSkillDir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceSkillDir, "node_modules", "pkg", "index.js"),
      "export {}",
    );

    const skillUsagePaths = await syncWorkspaceSkills({
      ...syncOptions(sourceWorkspace, targetWorkspace),
      config: {
        ...isolatedConfig,
        skills: { load: { extraDirs: [path.join(sourceWorkspace, ".extra")] } },
      },
    });

    expect(skillUsagePaths).toEqual([
      {
        readPath: skillPath(targetWorkspace, "demo-skill", "SKILL.md"),
        skillFile: path.join(workspaceSkillDir, "SKILL.md"),
        skillName: "demo-skill",
        skillSource: "workspace",
      },
    ]);

    const prompt = await buildPrompt(targetWorkspace);

    expect(prompt).toContain("Workspace version");
    expect(prompt).not.toContain("Managed version");
    expect(prompt).not.toContain("Bundled version");
    expect(prompt).not.toContain("Extra version");
    expect(prompt.replaceAll("\\", "/")).toContain("demo-skill/SKILL.md");
    expect(await pathExists(skillPath(targetWorkspace, "demo-skill", ".git"))).toBe(false);
    expect(await pathExists(skillPath(targetWorkspace, "demo-skill", "node_modules"))).toBe(false);
  });

  it("skips discovery and copying when the synced snapshot still matches", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    await writeTestSkill(skillPath(sourceWorkspace, "alpha"), "alpha", "Alpha skill");
    await writeSkill({
      dir: skillPath(sourceWorkspace, "hidden"),
      name: "hidden",
      description: "Prompt-hidden skill",
      frontmatterExtra: "disable-model-invocation: true",
    });
    const skillsSnapshot = await buildSnapshot(sourceWorkspace);
    expect(skillsSnapshot.skills.map((skill) => skill.name)).toEqual(["alpha", "hidden"]);
    expect(skillsSnapshot.resolvedSkills?.map((skill) => skill.name)).toEqual(["alpha"]);
    const params = {
      ...syncOptions(sourceWorkspace, targetWorkspace),
      skillsSnapshot,
    };

    const first = await syncWorkspaceSkills(params);
    await fs.rm(path.join(sourceWorkspace, "skills"), { recursive: true, force: true });
    const second = await syncWorkspaceSkills(params);

    expect(second).toEqual(first);
    expect(await pathExists(skillPath(targetWorkspace, "alpha", "SKILL.md"))).toBe(true);
    expect(await pathExists(skillPath(targetWorkspace, "hidden", "SKILL.md"))).toBe(true);
  });

  it("keeps generated skills out of Git discovery across sync, cached reuse and refresh", async () => {
    const workspace = await createCaseDir("git-workspace");
    const targetWorkspace = path.join(workspace, ".openclaw", "sandbox-skills");
    const sourceSkillDir = skillPath(workspace, "alpha");
    const generatedSkill = ".openclaw/sandbox-skills/skills/alpha/SKILL.md";
    const generatedRoot = path.join(targetWorkspace, "skills");
    const git = async (...args: string[]) =>
      (
        await promisify(execFile)("git", args, { cwd: workspace, env: createNestedGitEnv() })
      ).stdout.trim();
    await writeTestSkill(sourceSkillDir, "alpha", "Original skill");
    await fs.mkdir(targetWorkspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "README.md"), "original\n");
    await git("init", "--quiet");
    await git("add", "README.md");
    await fs.writeFile(path.join(workspace, "README.md"), "changed\n");
    await fs.writeFile(path.join(workspace, ".openclaw", "project.txt"), "project\n");
    await fs.writeFile(path.join(targetWorkspace, "notes.txt"), "ordinary sibling\n");
    const params = {
      ...syncOptions(workspace, targetWorkspace),
      skillsSnapshot: await buildSnapshot(workspace),
    };
    const expectProjectChanges = async () => {
      expect(await git("ls-files", "--others", "--exclude-standard")).toBe(
        ".openclaw/project.txt\n.openclaw/sandbox-skills/notes.txt\nskills/alpha/SKILL.md",
      );
      expect(await git("diff", "--name-only")).toContain("README.md");
    };

    await syncWorkspaceSkills(params);
    await expectProjectChanges();
    await git("add", "--force", generatedSkill);
    await fs.appendFile(path.join(workspace, generatedSkill), "\ntracked edit\n");
    const cachedMarker = path.join(generatedRoot, "alpha", "cached.txt");
    await fs.writeFile(cachedMarker, "retained by cache\n");
    await fs.rm(path.join(generatedRoot, ".gitignore"));

    await syncWorkspaceSkills(params);
    await expectProjectChanges();
    expect(await pathExists(cachedMarker)).toBe(true);
    expect(await git("diff", "--name-only")).toContain(generatedSkill);

    await writeTestSkill(sourceSkillDir, "alpha", "Refreshed skill");
    await refreshSkillsDiscovery({ workspaceDir: workspace });
    await syncWorkspaceSkills(params);
    await expectProjectChanges();
    expect(await pathExists(cachedMarker)).toBe(false);
    expect(await readText(workspace, generatedSkill)).toContain("Refreshed skill");
    expect(await git("diff", "--name-only")).toContain(generatedSkill);
  });

  it.each([
    { source: "execution", snapshot: true },
    { source: "execution-project", snapshot: "v2026.9.2" },
    { source: "workspace", snapshot: false },
    { source: "workshop", snapshot: false },
  ] as const)(
    "replaces same-name $source skills with snapshot=$snapshot",
    async ({ source, snapshot }) => {
      const agentWorkspace = await createCaseDir("agent-workspace");
      const firstWorkspace = await createCaseDir("source-a");
      const secondWorkspace = await createCaseDir("source-b");
      const targetWorkspace = await createCaseDir("target");
      const skillName = "shared-skill";
      const config = {
        plugins: { enabled: false },
        agents: {
          entries: {
            alpha: { agentDir: path.join(firstWorkspace, "agent"), workspace: agentWorkspace },
            beta: { agentDir: path.join(secondWorkspace, "agent"), workspace: agentWorkspace },
          },
        },
      } satisfies OpenClawConfig;
      const roots = [
        { agentId: "alpha", workspace: firstWorkspace },
        { agentId: "beta", workspace: secondWorkspace },
      ].map(({ agentId, workspace }) => ({
        agentId: source === "workshop" ? agentId : undefined,
        workspaceDir: source === "workspace" ? workspace : agentWorkspace,
        executionWorkspaceDir: source.startsWith("execution") ? workspace : undefined,
        skillDir: path.join(
          source === "workshop"
            ? resolveWorkshopSkillsDir(config, agentId)
            : source === "execution-project"
              ? path.join(workspace, ".agents", "skills")
              : path.join(workspace, "skills"),
          skillName,
        ),
        description: `${agentId}'s procedure`,
      }));
      for (const root of roots) {
        await writeTestSkill(root.skillDir, skillName, root.description);
        await fs.writeFile(path.join(root.skillDir, "instructions.txt"), root.description);
      }
      const snapshotVersion = getSkillsSnapshotVersion(agentWorkspace);
      for (const root of [roots[0]!, roots[1]!, roots[0]!]) {
        const persistedSnapshot =
          snapshot === "v2026.9.2"
            ? JSON.stringify({
                prompt: "",
                skills: [],
                skillFilter: [skillName],
                version: snapshotVersion,
                promptFormatVersion: 4,
                skillRoots: {
                  agentWorkspaceDir: root.workspaceDir,
                  executionSkillsDir: path.join(root.executionWorkspaceDir!, "skills"),
                },
              })
            : undefined;
        const skillsSnapshot = snapshot
          ? (
              await resolveReusableWorkspaceSkillSnapshot({
                workspaceDir: root.workspaceDir,
                executionWorkspaceDir: root.executionWorkspaceDir,
                agentId: root.agentId,
                config,
                skillFilter: [skillName],
                snapshotVersion,
                watch: false,
                existingSnapshot: persistedSnapshot ? JSON.parse(persistedSnapshot) : undefined,
              })
            ).snapshot
          : undefined;
        const usage = await syncWorkspaceSkills({
          sourceWorkspaceDir: root.workspaceDir,
          targetWorkspaceDir: targetWorkspace,
          agentId: root.agentId,
          config,
          skillFilter: [skillName],
          bundledSkillsDir: path.join(agentWorkspace, ".bundled"),
          managedSkillsDir: path.join(agentWorkspace, ".managed"),
          skillsSnapshot,
        });
        const syncedSkillDir = skillPath(targetWorkspace, skillName);
        expect(await readText(syncedSkillDir, "SKILL.md")).toContain(root.description);
        expect(await readText(syncedSkillDir, "instructions.txt")).toBe(root.description);
        expect(usage).toEqual([
          {
            readPath: path.join(syncedSkillDir, "SKILL.md"),
            skillFile: path.join(root.skillDir, "SKILL.md"),
            skillName,
            skillSource: "workspace",
          },
        ]);
      }
    },
  );

  it("rejects path-like tampering without deriving read paths from the manifest", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    for (const name of ["alpha", "beta"]) {
      await writeTestSkill(skillPath(sourceWorkspace, name), name, `${name} skill`);
    }
    const skillsSnapshot = await buildSnapshot(sourceWorkspace);
    const syncParams = {
      ...syncOptions(sourceWorkspace, targetWorkspace),
      skillsSnapshot,
    };
    await syncWorkspaceSkills(syncParams);

    const targetSkillsDir = path.join(targetWorkspace, "skills");
    const manifestPath = path.join(targetSkillsDir, ".openclaw-sync.json");
    const manifest = JSON.parse(await readText(manifestPath)) as {
      skillsVersion: number;
      entryKeys: string[];
    };
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        entryKeys: ["../escape", "..\\escape"],
      }),
    );

    const staleMarker = path.join(targetSkillsDir, "alpha", "stale.txt");
    await fs.writeFile(staleMarker, "stale");
    const usagePaths = await syncWorkspaceSkills(syncParams);

    expect(await pathExists(staleMarker)).toBe(false);
    for (const name of ["alpha", "beta"]) {
      expect(await readText(targetSkillsDir, name, "SKILL.md")).toContain(`${name} skill`);
    }
    expect(
      usagePaths.every((entry) => {
        const relative = path.relative(targetSkillsDir, entry.readPath);
        return relative !== ".." && !relative.startsWith(`..${path.sep}`);
      }),
    ).toBe(true);
    expect(await pathExists(path.resolve(targetSkillsDir, "../escape"))).toBe(false);
  });

  it("incrementally adds and removes skills while preserving unchanged destinations", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    for (const name of ["alpha", "beta", "gamma"]) {
      await writeTestSkill(skillPath(sourceWorkspace, name), name, `${name} skill`);
    }
    const snapshotVersion = getSkillsSnapshotVersion(sourceWorkspace);
    const firstSnapshot = await buildSnapshot(sourceWorkspace, {
      skillFilter: ["alpha", "beta"],
      snapshotVersion,
    });
    await syncWorkspaceSkills({
      ...syncOptions(sourceWorkspace, targetWorkspace),
      skillFilter: ["alpha", "beta"],
      skillsSnapshot: firstSnapshot,
    });
    const preservedMarker = skillPath(targetWorkspace, "alpha", "preserved.txt");
    await fs.writeFile(preservedMarker, "preserved");

    const secondSnapshot = await buildSnapshot(sourceWorkspace, {
      skillFilter: ["alpha", "gamma"],
      snapshotVersion,
    });
    await syncWorkspaceSkills({
      ...syncOptions(sourceWorkspace, targetWorkspace),
      skillFilter: ["alpha", "gamma"],
      skillsSnapshot: secondSnapshot,
    });
    expect(await readText(preservedMarker)).toBe("preserved");
    expect(await pathExists(skillPath(targetWorkspace, "beta"))).toBe(false);
    expect(await pathExists(skillPath(targetWorkspace, "gamma", "SKILL.md"))).toBe(true);
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0).each(["copied source"])(
    "refreshes read-only skill trees from a %s",
    async () => {
      const sourceWorkspace = await createCaseDir("readonly-source");
      const targetWorkspace = await createCaseDir("readonly-target");
      const outsideDir = await createCaseDir("readonly-outside");
      const sourceSkill = path.join(sourceWorkspace, ".bundled", "sealed");
      const targetSkill = skillPath(targetWorkspace, "sealed");
      await writeTestSkill(sourceSkill, "sealed", "Sealed release skill");
      await fs.mkdir(path.join(sourceSkill, "scripts"));
      await fs.writeFile(path.join(sourceSkill, "scripts", "run.sh"), "#!/bin/sh\necho sealed\n");
      await fs.chmod(path.join(sourceSkill, "SKILL.md"), 0o444);
      await fs.chmod(path.join(sourceSkill, "scripts", "run.sh"), 0o555);
      const directories = [sourceSkill, path.join(sourceSkill, "scripts"), outsideDir];
      try {
        for (const directory of directories) {
          await fs.chmod(directory, 0o555);
        }
        await syncSourceSkillsToTarget(sourceWorkspace, targetWorkspace);
        await refreshSkillsDiscovery({ workspaceDir: sourceWorkspace });

        await syncSourceSkillsToTarget(sourceWorkspace, targetWorkspace);

        for (const relative of ["", "scripts"]) {
          expect((await fs.stat(path.join(targetSkill, relative))).mode & 0o777).toBe(0o755);
          expect((await fs.stat(path.join(sourceSkill, relative))).mode & 0o777).toBe(0o555);
        }
        expect(await readText(targetSkill, "SKILL.md")).toContain("Sealed release skill");
        expect(await readText(targetSkill, "scripts", "run.sh")).toBe("#!/bin/sh\necho sealed\n");
        expect((await fs.stat(path.join(targetSkill, "SKILL.md"))).mode & 0o777).toBe(0o444);
        expect((await fs.stat(path.join(targetSkill, "scripts", "run.sh"))).mode & 0o777).toBe(
          0o555,
        );
        expect((await fs.stat(outsideDir)).mode & 0o777).toBe(0o555);
        expect(await pathExists(path.join(targetSkill, "stale.txt"))).toBe(false);
        expect(await pathExists(path.join(targetSkill, "outside"))).toBe(false);
      } finally {
        for (const directory of [...directories, targetSkill, path.join(targetSkill, "scripts")]) {
          await fs.chmod(directory, 0o700).catch((error: unknown) => {
            if (!hasErrnoCode(error, "ENOENT")) {
              throw error;
            }
          });
        }
      }
    },
  );

  it("does not publish a manifest when a refreshed copy fails", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    const sourceSkillDir = skillPath(sourceWorkspace, "alpha");
    await writeTestSkill(sourceSkillDir, "alpha", "Alpha skill");
    await fs.writeFile(path.join(sourceSkillDir, "asset.txt"), "before");
    const firstSnapshot = await buildSnapshot(sourceWorkspace);
    const syncParams = {
      ...syncOptions(sourceWorkspace, targetWorkspace),
      skillsSnapshot: firstSnapshot,
    };
    await syncWorkspaceSkills(syncParams);

    await fs.writeFile(path.join(sourceSkillDir, "asset.txt"), "after");
    await refreshSkillsDiscovery({ workspaceDir: sourceWorkspace });
    const nextVersion = getSkillsSnapshotVersion(sourceWorkspace);
    const secondSnapshot = await buildSnapshot(sourceWorkspace, { snapshotVersion: nextVersion });
    const lstat = fs.lstat.bind(fs);
    const read = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (nodeFilePath(args[0]) === path.join(sourceSkillDir, "asset.txt")) {
        throw new Error("injected copy failure");
      }
      return lstat(...args);
    });
    try {
      await syncWorkspaceSkills({ ...syncParams, skillsSnapshot: secondSnapshot });
    } finally {
      read.mockRestore();
    }

    const manifestPath = skillPath(targetWorkspace, ".openclaw-sync.json");
    expect(await pathExists(manifestPath)).toBe(false);
    await syncWorkspaceSkills({ ...syncParams, skillsSnapshot: secondSnapshot });
    expect(await pathExists(manifestPath)).toBe(true);
    expect(await readText(skillPath(targetWorkspace, "alpha", "asset.txt"))).toBe("after");

    const interruptedTemp = skillPath(targetWorkspace, ".openclaw-sync.interrupted.tmp");
    await fs.rm(manifestPath);
    await fs.writeFile(interruptedTemp, "partial");
    await syncWorkspaceSkills({ ...syncParams, skillsSnapshot: secondSnapshot });
    expect(await pathExists(interruptedTemp)).toBe(false);
    expect(await pathExists(manifestPath)).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "refreshes prior read-only copies without changing linked targets or the skills mount",
    async () => {
      const sourceWorkspace = await cloneSourceTemplate();
      await fs.chmod(skillPath(sourceWorkspace, "demo-skill"), 0o755);
      const targetWorkspace = await createCaseDir("target");
      const targetSkillsDir = path.join(targetWorkspace, "skills");
      const staleDir = path.join(targetSkillsDir, "demo-skill");
      const nestedDir = path.join(staleDir, "references");
      const outsideDir = await createCaseDir("outside");
      const outsideFile = path.join(outsideDir, "SKILL.md");
      await fs.mkdir(nestedDir, { recursive: true });
      await fs.writeFile(path.join(staleDir, "SKILL.md"), "# Stale\n", { mode: 0o444 });
      await fs.writeFile(path.join(nestedDir, "old.txt"), "old", { mode: 0o444 });
      await fs.writeFile(outsideFile, "outside", { mode: 0o444 });
      // Pin the linked target mode independently of the caller's umask.
      await fs.chmod(outsideFile, 0o444);
      await fs.symlink(outsideDir, path.join(staleDir, "linked-directory"));
      await fs.symlink(outsideFile, path.join(staleDir, "linked-file"));
      await fs.symlink(outsideDir, path.join(targetSkillsDir, "linked-directory"));
      await fs.symlink(outsideFile, path.join(targetSkillsDir, "linked-file"));
      await fs.chmod(outsideDir, 0o555);
      await fs.chmod(nestedDir, 0o555);
      await fs.chmod(staleDir, 0o555);
      const before = await fs.stat(targetSkillsDir);
      try {
        await syncSourceSkillsToTarget(sourceWorkspace, targetWorkspace);
        expect((await fs.stat(targetSkillsDir)).ino).toBe(before.ino);
        expect(await readText(staleDir, "SKILL.md")).toContain("Workspace version");
        expect(await pathExists(nestedDir)).toBe(false);
        expect(await pathExists(path.join(targetSkillsDir, "linked-directory"))).toBe(false);
        expect(await pathExists(path.join(targetSkillsDir, "linked-file"))).toBe(false);
        expect(await readText(outsideFile)).toBe("outside");
        expect((await fs.stat(outsideDir)).mode & 0o777).toBe(0o555);
        expect((await fs.stat(outsideFile)).mode & 0o777).toBe(0o444);
        expect((await fs.stat(staleDir)).mode & 0o022).toBe(0);
      } finally {
        await fs.chmod(outsideDir, 0o755);
        if (await pathExists(staleDir)) {
          await fs.chmod(staleDir, 0o755);
        }
        if (await pathExists(nestedDir)) {
          await fs.chmod(nestedDir, 0o755);
        }
      }
    },
  );

  it("syncs the explicit agent skill subset instead of inherited defaults", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    await writeTestSkill(skillPath(sourceWorkspace, "foo_bar"), "foo_bar", "Underscore variant");
    await writeTestSkill(skillPath(sourceWorkspace, "foo.dot"), "foo.dot", "Dot variant");

    await syncWorkspaceSkills({
      ...syncOptions(sourceWorkspace, targetWorkspace),
      agentId: "alpha",
      config: {
        ...isolatedConfig,
        agents: {
          defaults: { skills: ["foo_bar", "foo.dot"] },
          entries: { alpha: { skills: ["foo_bar"] } },
        },
      },
    });

    const prompt = await buildPrompt(targetWorkspace);

    expect(prompt).toContain("Underscore variant");
    expect(prompt).not.toContain("Dot variant");
    expect(await pathExists(skillPath(targetWorkspace, "foo_bar", "SKILL.md"))).toBe(true);
    expect(await pathExists(skillPath(targetWorkspace, "foo.dot", "SKILL.md"))).toBe(false);
  });
  it.runIf(process.platform !== "win32")(
    "does not sync workspace skills that resolve outside the source workspace root",
    async () => {
      const sourceWorkspace = await createCaseDir("source");
      const targetWorkspace = await createCaseDir("target");
      const outsideRoot = await createCaseDir("outside");
      const outsideSkillDir = path.join(outsideRoot, "escaped-skill");

      await writeTestSkill(outsideSkillDir, "escaped-skill", "Outside source workspace");
      await fs.mkdir(path.join(sourceWorkspace, "skills"), { recursive: true });
      await fs.symlink(outsideSkillDir, skillPath(sourceWorkspace, "escaped-skill"), "dir");

      await syncSourceSkillsToTarget(sourceWorkspace, targetWorkspace);

      const prompt = await buildPrompt(targetWorkspace);

      expect(prompt).not.toContain("escaped-skill");
      expect(await pathExists(skillPath(targetWorkspace, "escaped-skill", "SKILL.md"))).toBe(false);
    },
  );
  it("keeps synced skills confined under target workspace when frontmatter name uses traversal", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    const escapeId = fixtureCount;
    const traversalName = `../../../skill-sync-escape-${escapeId}`;
    const escapedDest = path.resolve(targetWorkspace, "skills", traversalName);

    await writeTestSkill(
      skillPath(sourceWorkspace, "safe-traversal-skill"),
      traversalName,
      "Traversal skill",
    );

    expect(path.relative(path.join(targetWorkspace, "skills"), escapedDest).startsWith("..")).toBe(
      true,
    );
    expect(await pathExists(escapedDest)).toBe(false);
    await syncSourceSkillsToTarget(sourceWorkspace, targetWorkspace);
    expect(await pathExists(skillPath(targetWorkspace, "safe-traversal-skill", "SKILL.md"))).toBe(
      true,
    );
    expect(await pathExists(escapedDest)).toBe(false);
  });
  it("applies skill filters, including empty lists", async () => {
    const workspaceDir = await createCaseDir("workspace");
    await writeTestSkill(skillPath(workspaceDir, "alpha"), "alpha", "Alpha skill");
    await writeTestSkill(skillPath(workspaceDir, "beta"), "beta", "Beta skill");

    const filteredPrompt = await buildPrompt(workspaceDir, { skillFilter: ["alpha"] });
    expect(filteredPrompt).toContain("alpha");
    expect(filteredPrompt).not.toContain("beta");

    const emptyPrompt = await buildPrompt(workspaceDir, { skillFilter: [] });
    expect(emptyPrompt).toBe("");
  });

  it("syncs managed symlinked skills as real directories in the target workspace", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    const managedDir = path.join(sourceWorkspace, ".managed");
    const skillName = "managed-linked";
    const targetSkillDir = path.join(await createCaseDir("manager-cache"), ".hidden-target");
    await writeSkill({
      dir: targetSkillDir,
      name: skillName,
      description: "Managed symlink target",
    });
    await fs.mkdir(managedDir, { recursive: true });
    await fs.symlink(
      targetSkillDir,
      path.join(managedDir, skillName),
      process.platform === "win32" ? "junction" : "dir",
    );

    await withEnvAsync({ HOME: sourceWorkspace }, () =>
      syncWorkspaceSkills({
        config: isolatedConfig,
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
        bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
        managedSkillsDir: managedDir,
        skillFilter: [skillName],
      }),
    );

    const syncedSkillDir = path.join(targetWorkspace, "skills", skillName);
    expect(await pathExists(path.join(syncedSkillDir, "SKILL.md"))).toBe(true);
    expect((await fs.lstat(syncedSkillDir)).isSymbolicLink()).toBe(false);
    expect(await pathExists(path.join(targetWorkspace, "skills", ".hidden-target"))).toBe(false);
    expect(
      (
        await buildSkillSnapshot(targetWorkspace, {
          bundledSkillsDir: path.join(targetWorkspace, ".bundled"),
          managedSkillsDir: path.join(targetWorkspace, ".managed"),
          skillFilter: [skillName],
        })
      ).prompt,
    ).toContain("Managed symlink target");
  });
});

describe("syncWorkspaceSkills for plugin skills", () => {
  it("syncs plugin skills from symlinked directories to sandbox workspace", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");

    const pluginRoot = await createCaseDir("skill-plugin");
    const realPluginSkillDir = path.join(pluginRoot, "skills", "wiki-maintainer");
    await writePluginWithSkill({
      pluginRoot,
      pluginId: "skill-sync-fixture",
      skillId: "wiki-maintainer",
      skillDescription: "Wiki maintenance skill for sandboxed agents",
    });

    const pluginSkillsDir = path.join(sourceWorkspace, ".openclaw", "plugin-skills");
    await fs.mkdir(pluginSkillsDir, { recursive: true });
    const symlinkPath = path.join(pluginSkillsDir, "wiki-maintainer");

    await fs.symlink(
      realPluginSkillDir,
      symlinkPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    const skillUsagePaths = await syncWorkspaceSkills({
      config: {
        plugins: {
          allow: ["skill-sync-fixture"],
          entries: { "skill-sync-fixture": { enabled: true } },
          load: { paths: [pluginRoot] },
        },
      },
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      pluginSkillsDir,
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });

    const syncedSkillDir = path.join(targetWorkspace, "skills", "wiki-maintainer");
    const syncedSkillMd = path.join(syncedSkillDir, "SKILL.md");
    const syncedStat = await fs.lstat(syncedSkillDir);
    const prompt = (
      await buildSkillSnapshot(targetWorkspace, {
        bundledSkillsDir: path.join(targetWorkspace, ".bundled"),
        managedSkillsDir: path.join(targetWorkspace, ".managed"),
      })
    ).prompt.replaceAll("\\", "/");

    expect(await pathExists(syncedSkillMd)).toBe(true);
    expect(syncedStat.isSymbolicLink()).toBe(false);
    expect(prompt).toContain("Wiki maintenance skill for sandboxed agents");
    expect(prompt).toContain("skills/wiki-maintainer/SKILL.md");
    expect(prompt).not.toContain(realPluginSkillDir.replaceAll("\\", "/"));
    expect(prompt).not.toContain(pluginSkillsDir.replaceAll("\\", "/"));
    expect(prompt).not.toContain(symlinkPath.replaceAll("\\", "/"));
    expect(skillUsagePaths).toEqual([
      {
        readPath: syncedSkillMd,
        skillFile: path.join(realPluginSkillDir, "SKILL.md"),
        skillName: "wiki-maintainer",
        skillSource: "workspace",
      },
    ]);
  });

  it("does not sync plugin skills that escape allowed root", async () => {
    const sourceWorkspace = await createCaseDir("source-escape");
    const targetWorkspace = await createCaseDir("target-escape");

    const outsideRoot = await createCaseDir("outside-root");
    const escapedSkillDir = path.join(outsideRoot, "escaped-skill");
    await writeTestSkill(escapedSkillDir, "escaped-skill", "Should not be synced");

    const pluginSkillsDir = path.join(sourceWorkspace, ".openclaw", "plugin-skills");
    await fs.mkdir(pluginSkillsDir, { recursive: true });
    await fs.symlink(
      escapedSkillDir,
      path.join(pluginSkillsDir, "escaped-skill"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const allowedRoot = await createCaseDir("allowed-root");
    await writePluginWithSkill({
      pluginRoot: allowedRoot,
      pluginId: "skill-sync-fixture",
      skillId: "allowed-skill",
      skillDescription: "Allowed plugin skill",
    });

    await syncWorkspaceSkills({
      ...syncOptions(sourceWorkspace, targetWorkspace),
      config: {
        plugins: {
          allow: ["skill-sync-fixture"],
          entries: { "skill-sync-fixture": { enabled: true } },
          load: { paths: [allowedRoot] },
        },
      },
      pluginSkillsDir,
    });

    expect(await pathExists(skillPath(targetWorkspace, "escaped-skill", "SKILL.md"))).toBe(false);
    expect(await pathExists(skillPath(targetWorkspace, "allowed-skill", "SKILL.md"))).toBe(true);
  });
});
