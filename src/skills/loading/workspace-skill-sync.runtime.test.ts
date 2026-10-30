import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { root as fsSafeRoot } from "@openclaw/fs-safe/root";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createNestedGitEnv } from "../../../test/helpers/temp-repo.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withDiagnosticsTimelineObserver } from "../../infra/diagnostics-timeline.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { nodeFilePath } from "../../test-utils/node-file-path.js";
import {
  getSkillsSnapshotVersion,
  markSkillsSupportingFilesChanged,
} from "../runtime/refresh-state.js";
import { refreshSkillsDiscovery } from "../runtime/refresh.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../runtime/session-snapshot.js";
import { writePluginWithSkill } from "../test-support/skill-plugin-fixtures.test-support.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import { useLoadingFixture, writeSkillFixture as writeSkill } from "./loading.test-support.js";
import { ensureWritableSkillDirectories } from "./skill-directory-modes.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";
import { syncWorkspaceSkills } from "./workspace-skill-sync.runtime.js";

// These tests publish resource revisions explicitly; passive scans would race reuse assertions.
const isolatedConfig = {
  plugins: { enabled: false },
  skills: { load: { watch: false } },
} satisfies OpenClawConfig;

function sourceOptions(workspace: string) {
  return {
    config: isolatedConfig,
    bundledSkillsDir: path.join(workspace, ".bundled"),
    managedSkillsDir: path.join(workspace, ".managed"),
  };
}

const skillPath = (workspace: string, ...parts: string[]) =>
  path.join(workspace, "skills", ...parts);
const readText = (...parts: string[]) => fs.readFile(path.join(...parts), "utf8");

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

const fixture = useLoadingFixture("openclaw-skills-sync-suite-");
const newDir = (label?: string) => fixture.createDir(label);

function sync(
  source: string,
  target: string,
  options: Partial<Parameters<typeof syncWorkspaceSkills>[0]> = {},
) {
  return syncWorkspaceSkills({ ...syncOptions(source, target), ...options });
}

function syncOptions(source: string, target: string) {
  return {
    ...sourceOptions(source),
    sourceWorkspaceDir: source,
    targetWorkspaceDir: target,
  };
}

async function setupSkills(names: string[] = []) {
  const source = await newDir("source");
  const target = await newDir("target");
  for (const name of names) {
    await writeSkill(skillPath(source, name), name, `${name} skill`);
  }
  return { source, target };
}

async function pluginSkill(name: string, description: string) {
  const pluginRoot = await newDir("plugin");
  await writePluginWithSkill({
    pluginRoot,
    pluginId: "skill-sync-fixture",
    skillId: name,
    skillDescription: description,
  });
  return {
    root: pluginRoot,
    dir: path.join(pluginRoot, "skills", name),
    config: pluginConfig(pluginRoot),
  };
}

async function writeFiles(root: string, files: Record<string, string>, mode?: number) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { mode });
  }
}

async function chmod(mode: number, ...paths: string[]) {
  for (const file of paths) {
    await fs.chmod(file, mode).catch((error: unknown) => {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    });
  }
}

const modeOf = async (file: string) => (await fs.stat(file)).mode & 0o777;

async function linkSkill(target: string, link: string) {
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

function pluginConfig(root: string): OpenClawConfig {
  return {
    plugins: {
      allow: ["skill-sync-fixture"],
      entries: { "skill-sync-fixture": { enabled: true } },
      load: { paths: [root] },
    },
  };
}

function expectUsage(usage: unknown, source: string, target: string, name: string) {
  expect(usage).toEqual([
    {
      readPath: path.join(target, "SKILL.md"),
      skillFile: path.join(source, "SKILL.md"),
      skillName: name,
      skillSource: "workspace",
    },
  ]);
}

function buildSnapshot(workspaceDir: string, opts?: Parameters<typeof buildSkillSnapshot>[1]) {
  return buildSkillSnapshot(workspaceDir, {
    ...sourceOptions(workspaceDir),
    snapshotVersion: getSkillsSnapshotVersion(workspaceDir),
    ...opts,
  });
}

describe("syncWorkspaceSkills", () => {
  it.runIf(process.platform !== "win32")(
    "avoids Node openSync calls for writable skill directories",
    async () => {
      const directory = await newDir("writable");
      await fs.mkdir(path.join(directory, "skill", "references"), { recursive: true });
      await fs.chmod(path.join(directory, "skill", "references"), 0o755);
      const boundary = await fsSafeRoot(directory);
      const open = vi.spyOn(fsSync, "openSync");
      try {
        await ensureWritableSkillDirectories(boundary, "skill");
        expect(open).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
      }
      expect(await modeOf(path.join(directory, "skill", "references"))).toBe(0o755);
    },
  );

  it("attributes a queued sync to waiting rather than directory or copy work", async () => {
    const { source, target } = await setupSkills(["alpha"]);
    const skillsSnapshot = await buildSnapshot(source);
    const entered = createDeferred();
    const resume = createDeferred();
    const lstat = fs.lstat.bind(fs);
    let held = false;
    const read = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (!held && nodeFilePath(args[0]) === skillPath(target)) {
        held = true;
        entered.resolve();
        await resume.promise;
      }
      return lstat(...args);
    });
    const phases: string[][] = [[], []];
    const completed: string[][] = [[], []];
    const observed = (index: number) =>
      withDiagnosticsTimelineObserver(
        (name) => {
          phases[index]!.push(name);
          return () => {
            completed[index]!.push(name);
          };
        },
        () => sync(source, target, { skillsSnapshot }),
      );
    const first = observed(0);
    let second: Promise<unknown> | undefined;
    try {
      await awaitGateBeforeSettlement(entered.promise, first, "Skill sync skipped directory read");
      second = observed(1);
      expect(phases[1]).toEqual(["attempt.setup.sandbox.layout.skills_sync.queue_wait"]);
      expect(completed[1]).toEqual([]);
      expect(phases[0]).toContain("attempt.setup.sandbox.layout.skills_sync.directory");
      resume.resolve();
      await Promise.all([first, second]);
      expect(completed[1]).toEqual(phases[1]);
      expect(phases[0]).toContain("attempt.setup.sandbox.layout.skills_sync.copy_tree");
      expect(phases[1]).not.toContain("attempt.setup.sandbox.layout.skills_sync.copy_tree");
    } finally {
      resume.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      read.mockRestore();
    }
  });

  it("copies skills without repository internals or dependencies", async () => {
    const { source, target } = await setupSkills(["demo-skill"]);
    const workspaceSkillDir = skillPath(source, "demo-skill");

    await writeFiles(workspaceSkillDir, {
      ".git/config": "gitdir",
      "node_modules/pkg/index.js": "export {}",
    });

    const skillUsagePaths = await sync(source, target);

    expectUsage(skillUsagePaths, workspaceSkillDir, skillPath(target, "demo-skill"), "demo-skill");

    expect(await readText(skillPath(target, "demo-skill", "SKILL.md"))).toContain(
      "demo-skill skill",
    );
    expect(await exists(skillPath(target, "demo-skill", ".git"))).toBe(false);
    expect(await exists(skillPath(target, "demo-skill", "node_modules"))).toBe(false);
  });

  it("copies rebuildable skills without blocking fsync (#181928)", async () => {
    const { source, target } = await setupSkills(["alpha"]);
    const skillsSnapshot = await buildSnapshot(source);
    const fsync = vi.spyOn(fsSync, "fsyncSync");
    try {
      await sync(source, target, { skillsSnapshot });
      expect(fsync).not.toHaveBeenCalled();
    } finally {
      fsync.mockRestore();
    }
  });

  it("skips discovery and copying when the synced snapshot still matches", async () => {
    const { source, target } = await setupSkills();
    await writeSkill(skillPath(source, "alpha"), "alpha", "Alpha skill");
    await writeSkill(skillPath(source, "hidden"), "hidden", "Prompt-hidden skill", {
      frontmatterExtra: "disable-model-invocation: true",
    });
    const skillsSnapshot = await buildSnapshot(source);
    const params = {
      ...syncOptions(source, target),
      skillsSnapshot,
    };

    const first = await syncWorkspaceSkills(params);
    const ignorePath = skillPath(target, ".gitignore");
    await fs.utimes(ignorePath, 1, 1);
    await fs.rm(path.join(source, "skills"), { recursive: true, force: true });
    const second = await syncWorkspaceSkills(params);

    expect((await fs.stat(ignorePath)).mtimeMs).toBe(1000);
    expect(second).toEqual(first);
    expect(await exists(skillPath(target, "alpha", "SKILL.md"))).toBe(true);
    expect(await exists(skillPath(target, "hidden", "SKILL.md"))).toBe(true);
    await fs.writeFile(ignorePath, "edited\n");
    await syncWorkspaceSkills(params);
    expect(await readText(ignorePath)).toBe("*\n");
    await fs.chmod(ignorePath, 0o444);
    await syncWorkspaceSkills(params);
    expect((await fs.stat(ignorePath)).mode & 0o200).toBe(0o200);
  });

  it("keeps generated skills out of Git discovery across sync, cached reuse and refresh", async () => {
    const workspace = await newDir("git-workspace");
    const target = path.join(workspace, ".openclaw", "sandbox-skills");
    const sourceSkill = skillPath(workspace, "alpha");
    const generatedSkill = ".openclaw/sandbox-skills/skills/alpha/SKILL.md";
    const generatedRoot = path.join(target, "skills");
    const git = async (...args: string[]) =>
      (
        await promisify(execFile)("git", args, { cwd: workspace, env: createNestedGitEnv() })
      ).stdout.trim();
    await writeSkill(sourceSkill, "alpha", "Original skill");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(workspace, "README.md"), "original\n");
    await git("init", "--quiet");
    await git("add", "README.md");
    await fs.writeFile(path.join(workspace, "README.md"), "changed\n");
    await fs.writeFile(path.join(workspace, ".openclaw", "project.txt"), "project\n");
    await fs.writeFile(path.join(target, "notes.txt"), "ordinary sibling\n");
    const params = {
      ...syncOptions(workspace, target),
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
    expect(await exists(cachedMarker)).toBe(true);
    expect(await git("diff", "--name-only")).toContain(generatedSkill);

    await writeSkill(sourceSkill, "alpha", "Refreshed skill");
    await refreshSkillsDiscovery({ workspaceDir: workspace });
    await syncWorkspaceSkills(params);
    await expectProjectChanges();
    expect(await exists(cachedMarker)).toBe(false);
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
      const agentWorkspace = await newDir("agent-workspace");
      const firstWorkspace = await newDir("source-a");
      const secondWorkspace = await newDir("source-b");
      const target = await newDir("target");
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
        await writeSkill(root.skillDir, skillName, root.description);
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
          targetWorkspaceDir: target,
          agentId: root.agentId,
          config,
          skillFilter: [skillName],
          bundledSkillsDir: path.join(agentWorkspace, ".bundled"),
          managedSkillsDir: path.join(agentWorkspace, ".managed"),
          skillsSnapshot,
        });
        const syncedSkillDir = skillPath(target, skillName);
        expect(await readText(syncedSkillDir, "SKILL.md")).toContain(root.description);
        expect(await readText(syncedSkillDir, "instructions.txt")).toBe(root.description);
        expectUsage(usage, root.skillDir, syncedSkillDir, skillName);
      }
    },
  );

  it("rejects path-like tampering without deriving read paths from the manifest", async () => {
    const { source, target } = await setupSkills(["alpha", "beta"]);

    const skillsSnapshot = await buildSnapshot(source);
    const syncParams = {
      ...syncOptions(source, target),
      skillsSnapshot,
    };
    await syncWorkspaceSkills(syncParams);

    const targetSkills = path.join(target, "skills");
    const manifestPath = path.join(targetSkills, ".openclaw-sync.json");
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

    const staleMarker = path.join(targetSkills, "alpha", "stale.txt");
    await fs.writeFile(staleMarker, "stale");
    const usagePaths = await syncWorkspaceSkills(syncParams);

    expect(await exists(staleMarker)).toBe(false);
    for (const name of ["alpha", "beta"]) {
      expect(await readText(targetSkills, name, "SKILL.md")).toContain(`${name} skill`);
    }
    expect(
      usagePaths.every((entry) => {
        const relative = path.relative(targetSkills, entry.readPath);
        return relative !== ".." && !relative.startsWith(`..${path.sep}`);
      }),
    ).toBe(true);
    expect(await exists(path.resolve(targetSkills, "../escape"))).toBe(false);
  });

  it("incrementally adds and removes skills while preserving unchanged destinations", async () => {
    const { source, target } = await setupSkills(["alpha", "beta", "gamma"]);
    const snapshotVersion = getSkillsSnapshotVersion(source);
    const selected = async (skillFilter: string[]) =>
      sync(source, target, {
        skillFilter,
        skillsSnapshot: await buildSnapshot(source, { skillFilter, snapshotVersion }),
      });
    await selected(["alpha", "beta"]);
    const preservedMarker = skillPath(target, "alpha", "preserved.txt");
    await fs.writeFile(preservedMarker, "preserved");

    await selected(["alpha", "gamma"]);
    expect(await readText(preservedMarker)).toBe("preserved");
    expect(await exists(skillPath(target, "beta"))).toBe(false);
    expect(await exists(skillPath(target, "gamma", "SKILL.md"))).toBe(true);
  });

  it("refreshes changed support files without replacing unchanged copies", async () => {
    const { source, target } = await setupSkills(["alpha"]);
    const sourceSkill = skillPath(source, "alpha");
    const targetSkill = skillPath(target, "alpha");
    await writeFiles(sourceSkill, {
      "references/changed.txt": "before",
      "references/removed.txt": "remove",
      "scripts/unchanged.txt": "keep",
      "scripts/edited.txt": "original",
    });
    const skillsSnapshot = await buildSnapshot(source);
    await sync(source, target, { skillsSnapshot });
    const unchanged = path.join(targetSkill, "scripts/unchanged.txt");
    const before = await fs.stat(unchanged);
    await fs.writeFile(path.join(sourceSkill, "references/changed.txt"), "after");
    await fs.rm(path.join(sourceSkill, "references/removed.txt"));
    await fs.writeFile(path.join(targetSkill, "unexpected.txt"), "stale");
    await fs.writeFile(path.join(targetSkill, "scripts/edited.txt"), "modified");
    markSkillsSupportingFilesChanged({ workspaceDir: source });

    await sync(source, target, { skillsSnapshot });

    expect(await readText(targetSkill, "references/changed.txt")).toBe("after");
    expect(await exists(path.join(targetSkill, "references/removed.txt"))).toBe(false);
    expect(await exists(path.join(targetSkill, "unexpected.txt"))).toBe(false);
    expect(await readText(unchanged)).toBe("keep");
    expect(await readText(targetSkill, "scripts/edited.txt")).toBe("original");
    const after = await fs.stat(unchanged);
    expect({ ino: after.ino, mtime: after.mtimeMs }).toEqual({
      ino: before.ino,
      mtime: before.mtimeMs,
    });
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "refreshes read-only skill trees from a copied source",
    async () => {
      const { source, target } = await setupSkills();
      const sourceSkill = path.join(source, ".bundled", "sealed");
      const targetSkill = skillPath(target, "sealed");
      await writeSkill(sourceSkill, "sealed", "Sealed release skill");
      await writeFiles(sourceSkill, { "scripts/run.sh": "#!/bin/sh\necho sealed\n" });
      await fs.chmod(path.join(sourceSkill, "SKILL.md"), 0o444);
      await fs.chmod(path.join(sourceSkill, "scripts", "run.sh"), 0o555);
      const directories = [sourceSkill, path.join(sourceSkill, "scripts")];
      try {
        for (const directory of directories) {
          await fs.chmod(directory, 0o555);
        }
        await sync(source, target);
        await refreshSkillsDiscovery({ workspaceDir: source });

        await sync(source, target);

        for (const relative of ["", "scripts"]) {
          expect((await fs.stat(path.join(targetSkill, relative))).mode & 0o777).toBe(0o755);
          expect((await fs.stat(path.join(sourceSkill, relative))).mode & 0o777).toBe(0o555);
        }
        expect(await readText(targetSkill, "SKILL.md")).toContain("Sealed release skill");
        expect(await readText(targetSkill, "scripts", "run.sh")).toBe("#!/bin/sh\necho sealed\n");
        expect(await modeOf(path.join(targetSkill, "SKILL.md"))).toBe(0o444);
        expect(await modeOf(path.join(targetSkill, "scripts", "run.sh"))).toBe(0o555);
      } finally {
        await chmod(0o700, ...directories, targetSkill, path.join(targetSkill, "scripts"));
      }
    },
  );

  it("does not publish a manifest when a refreshed copy fails", async () => {
    const { source, target } = await setupSkills();
    const sourceSkill = skillPath(source, "alpha");
    await writeSkill(sourceSkill, "alpha", "Alpha skill");
    await fs.writeFile(path.join(sourceSkill, "asset.txt"), "before");
    const firstSnapshot = await buildSnapshot(source);
    const syncParams = {
      ...syncOptions(source, target),
      skillsSnapshot: firstSnapshot,
    };
    await syncWorkspaceSkills(syncParams);

    await fs.writeFile(path.join(sourceSkill, "asset.txt"), "after");
    await refreshSkillsDiscovery({ workspaceDir: source });
    const nextVersion = getSkillsSnapshotVersion(source);
    const secondSnapshot = await buildSnapshot(source, { snapshotVersion: nextVersion });
    const lstat = fs.lstat.bind(fs);
    const read = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (nodeFilePath(args[0]) === path.join(sourceSkill, "asset.txt")) {
        throw new Error("injected copy failure");
      }
      return lstat(...args);
    });
    try {
      await syncWorkspaceSkills({ ...syncParams, skillsSnapshot: secondSnapshot });
    } finally {
      read.mockRestore();
    }

    const manifestPath = skillPath(target, ".openclaw-sync.json");
    expect(await exists(manifestPath)).toBe(false);
    await syncWorkspaceSkills({ ...syncParams, skillsSnapshot: secondSnapshot });
    expect(await exists(manifestPath)).toBe(true);
    expect(await readText(skillPath(target, "alpha", "asset.txt"))).toBe("after");

    const interruptedTemp = skillPath(target, ".openclaw-sync.interrupted.tmp");
    await fs.rm(manifestPath);
    await fs.writeFile(interruptedTemp, "partial");
    await syncWorkspaceSkills({ ...syncParams, skillsSnapshot: secondSnapshot });
    expect(await exists(interruptedTemp)).toBe(false);
    expect(await exists(manifestPath)).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "refreshes prior read-only copies without changing linked targets or the skills mount",
    async () => {
      const { source, target } = await setupSkills(["demo-skill"]);
      await fs.chmod(skillPath(source, "demo-skill"), 0o755);
      const targetSkills = path.join(target, "skills");
      const staleDir = path.join(targetSkills, "demo-skill");
      const nestedDir = path.join(staleDir, "references");
      const outsideDir = await newDir("outside");
      const outsideFile = path.join(outsideDir, "SKILL.md");
      await writeFiles(staleDir, { "SKILL.md": "# Stale\n", "references/old.txt": "old" }, 0o444);
      await fs.writeFile(outsideFile, "outside", { mode: 0o444 });
      // Pin the linked target mode independently of the caller's umask.
      await fs.chmod(outsideFile, 0o444);
      for (const dir of [staleDir, targetSkills]) {
        await fs.symlink(outsideDir, path.join(dir, "linked-directory"));
        await fs.symlink(outsideFile, path.join(dir, "linked-file"));
      }
      for (const dir of [outsideDir, nestedDir, staleDir]) {
        await fs.chmod(dir, 0o555);
      }
      const before = await fs.stat(targetSkills);
      try {
        await sync(source, target);
        expect((await fs.stat(targetSkills)).ino).toBe(before.ino);
        expect(await readText(staleDir, "SKILL.md")).toContain("demo-skill skill");
        expect(await exists(nestedDir)).toBe(false);
        expect(await exists(path.join(targetSkills, "linked-directory"))).toBe(false);
        expect(await exists(path.join(targetSkills, "linked-file"))).toBe(false);
        expect(await readText(outsideFile)).toBe("outside");
        expect(await modeOf(outsideDir)).toBe(0o555);
        expect(await modeOf(outsideFile)).toBe(0o444);
        expect((await fs.stat(staleDir)).mode & 0o022).toBe(0);
      } finally {
        await chmod(0o755, outsideDir, staleDir, nestedDir);
      }
    },
  );

  it("syncs the explicit agent skill subset instead of inherited defaults", async () => {
    const { source, target } = await setupSkills();
    await writeSkill(skillPath(source, "foo_bar"), "foo_bar", "Underscore variant");
    await writeSkill(skillPath(source, "foo.dot"), "foo.dot", "Dot variant");

    await sync(source, target, {
      agentId: "alpha",
      config: {
        ...isolatedConfig,
        agents: {
          defaults: { skills: ["foo_bar", "foo.dot"] },
          entries: { alpha: { skills: ["foo_bar"] } },
        },
      },
    });

    expect(await exists(skillPath(target, "foo_bar", "SKILL.md"))).toBe(true);
    expect(await exists(skillPath(target, "foo.dot", "SKILL.md"))).toBe(false);
  });
  it.runIf(process.platform !== "win32")(
    "does not sync workspace skills that resolve outside the source workspace root",
    async () => {
      const source = await newDir("source");
      const target = await newDir("target");
      const outsideRoot = await newDir("outside");
      const outsideSkillDir = path.join(outsideRoot, "escaped-skill");

      await writeSkill(outsideSkillDir, "escaped-skill", "Outside source workspace");
      await fs.mkdir(path.join(source, "skills"), { recursive: true });
      await fs.symlink(outsideSkillDir, skillPath(source, "escaped-skill"), "dir");

      await sync(source, target);

      expect(await exists(skillPath(target, "escaped-skill", "SKILL.md"))).toBe(false);
    },
  );
  it("keeps synced skills confined under target workspace when frontmatter name uses traversal", async () => {
    const { source, target } = await setupSkills();
    const escapeId = path.basename(source);
    const traversalName = `../../../skill-sync-escape-${escapeId}`;
    const escapedDest = path.resolve(target, "skills", traversalName);

    await writeSkill(skillPath(source, "safe-traversal-skill"), traversalName, "Traversal skill");

    expect(path.relative(path.join(target, "skills"), escapedDest).startsWith("..")).toBe(true);
    expect(await exists(escapedDest)).toBe(false);
    await sync(source, target);
    expect(await exists(skillPath(target, "safe-traversal-skill", "SKILL.md"))).toBe(true);
    expect(await exists(escapedDest)).toBe(false);
  });

  it("syncs managed symlinked skills as real directories in the target workspace", async () => {
    const { source, target } = await setupSkills();
    const managedDir = path.join(source, ".managed");
    const skillName = "managed-linked";
    const targetSkillDir = path.join(await newDir("manager-cache"), ".hidden-target");
    await writeSkill(targetSkillDir, skillName, "Managed symlink target");
    await linkSkill(targetSkillDir, path.join(managedDir, skillName));

    await withEnvAsync({ HOME: source }, () =>
      sync(source, target, {
        skillFilter: [skillName],
      }),
    );

    const syncedSkillDir = path.join(target, "skills", skillName);
    expect(await exists(path.join(syncedSkillDir, "SKILL.md"))).toBe(true);
    expect((await fs.lstat(syncedSkillDir)).isSymbolicLink()).toBe(false);
    expect(await exists(path.join(target, "skills", ".hidden-target"))).toBe(false);
    expect(await readText(syncedSkillDir, "SKILL.md")).toContain("Managed symlink target");
  });
});

describe("syncWorkspaceSkills for plugin skills", () => {
  it("syncs plugin skills from symlinked directories to sandbox workspace", async () => {
    const { source, target } = await setupSkills();

    const plugin = await pluginSkill(
      "wiki-maintainer",
      "Wiki maintenance skill for sandboxed agents",
    );

    const pluginSkillsDir = path.join(source, ".openclaw", "plugin-skills");
    const symlinkPath = path.join(pluginSkillsDir, "wiki-maintainer");
    await linkSkill(plugin.dir, symlinkPath);

    const skillUsagePaths = await sync(source, target, {
      config: plugin.config,
      pluginSkillsDir,
    });

    const syncedSkillDir = path.join(target, "skills", "wiki-maintainer");
    const syncedSkillMd = path.join(syncedSkillDir, "SKILL.md");
    const syncedStat = await fs.lstat(syncedSkillDir);
    expect(await exists(syncedSkillMd)).toBe(true);
    expect(syncedStat.isSymbolicLink()).toBe(false);
    expect(await readText(syncedSkillMd)).toContain("Wiki maintenance skill for sandboxed agents");
    expectUsage(skillUsagePaths, plugin.dir, syncedSkillDir, "wiki-maintainer");
  });

  it("does not sync plugin skills that escape allowed root", async () => {
    const { source, target } = await setupSkills();

    const outsideRoot = await newDir("outside-root");
    const escapedSkillDir = path.join(outsideRoot, "escaped-skill");
    await writeSkill(escapedSkillDir, "escaped-skill", "Should not be synced");

    const pluginSkillsDir = path.join(source, ".openclaw", "plugin-skills");
    await linkSkill(escapedSkillDir, path.join(pluginSkillsDir, "escaped-skill"));

    const plugin = await pluginSkill("allowed-skill", "Allowed plugin skill");

    await sync(source, target, {
      config: plugin.config,
      pluginSkillsDir,
    });

    expect(await exists(skillPath(target, "escaped-skill", "SKILL.md"))).toBe(false);
    expect(await exists(skillPath(target, "allowed-skill", "SKILL.md"))).toBe(true);
  });
});
