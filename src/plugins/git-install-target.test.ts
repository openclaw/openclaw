import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePluginInstallPreflight } from "../cli/plugins-install-preflight.js";
import {
  parsePluginInstallRecordMap,
  serializePluginInstallRecordMap,
} from "../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { installPluginFromGitSpec } from "./git-install.js";
import {
  requestDeferredPluginInstall,
  takePluginInstallTransaction,
} from "./install-transaction.js";
import { writeArtifacts } from "./public-surface.test-support.js";
import { applyPluginUninstallDirectoryRemoval, planPluginUninstall } from "./uninstall.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe("git install target ownership", () => {
  let state: OpenClawTestState;
  let sourceSeed: string;
  let sourceDir: string;
  let spec: string;
  const operatorNote = "keep this checkout";

  async function git(cwd: string, ...args: string[]) {
    const result = await runCommandWithTimeout(["git", ...args], { cwd, timeoutMs: 10_000 });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  }
  const head = (dir = sourceDir) => git(dir, "rev-parse", "HEAD");
  async function commitPlugin(pluginId: string, version: string, root = sourceDir) {
    writeArtifacts(root, {
      "package.json": { name: "git-fixture", version, openclaw: { extensions: ["index.js"] } },
      "openclaw.plugin.json": { id: pluginId, configSchema: { type: "object", properties: {} } },
      "index.js": `export default ${JSON.stringify(version)};\n`,
    });
    await git(root, "add", ".");
    await git(root, "-c", "commit.gpgsign=false", "commit", "-m", version);
    return await head(root);
  }

  async function install(options: Partial<Parameters<typeof installPluginFromGitSpec>[0]> = {}) {
    const result = await installPluginFromGitSpec({ spec, ...options });
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result;
  }
  const read = (root: string, name: string) => fs.readFile(path.join(root, name), "utf8");

  beforeAll(async () => {
    sourceSeed = tempDirs.make("openclaw-git-install-seed-");
    await git(sourceSeed, "init", "--initial-branch=main");
    await git(sourceSeed, "config", "user.name", "OpenClaw Test");
    await git(sourceSeed, "config", "user.email", "test@openclaw.invalid");
    await commitPlugin("demo", "1.0.0", sourceSeed);
  });

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "git-install-target" });
    vi.stubEnv("NPM_CONFIG_GLOBALCONFIG", await state.writeText("global-npmrc", ""));
    sourceDir = state.path("source");
    await fs.cp(sourceSeed, sourceDir, { recursive: true });
    spec = `git:${pathToFileURL(sourceDir).href}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await state.cleanup();
  });

  it.each(["branch", "annotated-tag", "short-commit"] as const)(
    "installs the requested %s revision from a real Git repository",
    async (kind) => {
      await git(sourceDir, "switch", "-c", "feature/demo");
      const featureCommit = await commitPlugin("demo", "2.0.0");
      await git(sourceDir, "-c", "tag.gpgsign=false", "tag", "-a", "release", "-m", "release");
      await git(sourceDir, "switch", "main");
      const refs = {
        branch: "feature/demo",
        "annotated-tag": "release",
        "short-commit": featureCommit.slice(0, 12),
      };
      const ref = refs[kind];
      const result = await install({
        spec: `${spec}#${ref}`,
        expectedPluginId: "demo",
      });
      expect(result).toMatchObject({
        version: "2.0.0",
        git: { ref, commit: featureCommit },
      });
      expect(await head(result.targetDir)).toBe(featureCommit);
      await expect(read(result.targetDir, "index.js")).resolves.toBe('export default "2.0.0";\n');
      if (kind === "branch") {
        await git(sourceDir, "switch", "feature/demo");
        const nextCommit = await commitPlugin("demo", "3.0.0");
        await git(sourceDir, "switch", "main");
        const updated = await installPluginFromGitSpec({
          spec: `${spec}#${ref}`,
          mode: "update",
          expectedPluginId: "demo",
        });
        expect(updated).toMatchObject({
          ok: true,
          version: "3.0.0",
          targetDir: result.targetDir,
          git: { ref, commit: nextCommit },
        });
        expect(await head(result.targetDir)).toBe(nextCommit);
      }
    },
  );

  it("installs a nested package and keeps selections in separate managed checkouts", async () => {
    const nestedDir = path.join(sourceDir, "plugins", "nested");
    const commit = await commitPlugin("nested", "2.0.0", nestedDir);
    const installed = await install({ directory: "plugins/nested", expectedPluginId: "nested" });
    expect(installed).toMatchObject({
      version: "2.0.0",
      git: { commit, directory: "plugins/nested" },
    });
    expect(installed.targetDir).toMatch(/plugins[/\\]nested$/);
    await expect(read(installed.targetDir, "index.js")).resolves.toBe('export default "2.0.0";\n');
    const root = await install();
    expect(root.pluginId).toBe("demo");
    expect(root.targetDir).not.toBe(installed.targetDir);
  });

  it.each([" plugins/nested", ...(process.platform === "win32" ? [] : ["plugins/nested "])])(
    "preserves selection %j through record round-trip, update and uninstall",
    async (directory) => {
      const root = await install();
      const legacyRoot: PluginInstallRecord = {
        source: "git",
        spec,
        installPath: root.targetDir,
        gitUrl: root.git.url,
        gitCommit: root.git.commit,
      };
      const packageDir = path.join(sourceDir, directory);
      await commitPlugin("nested", "2.0.0", packageDir);
      const installed = await install({ directory, expectedPluginId: "nested" });
      const records = expectDefined(
        parsePluginInstallRecordMap(
          JSON.parse(
            serializePluginInstallRecordMap({
              demo: legacyRoot,
              nested: {
                source: "git",
                spec,
                installPath: installed.targetDir,
                gitUrl: installed.git.url,
                gitCommit: installed.git.commit,
                gitDirectory: installed.git.directory,
              },
            }),
          ),
        ),
        "round-tripped Git install records",
      );
      expect(records.demo).toEqual(legacyRoot);
      expect(records.demo).not.toHaveProperty("gitDirectory");
      expect(records.nested?.gitDirectory).toBe(directory);
      expect(records.nested?.installPath).toBe(installed.targetDir);
      const discovered = discoverOpenClawPlugins({
        installRecords: records,
        bundledRoot: state.path("empty-bundled"),
      });
      expect(discovered.candidates.map((candidate) => candidate.rootDir)).toContain(
        installed.targetDir,
      );
      const nextCommit = await commitPlugin("nested", "3.0.0", packageDir);
      const updated = await install({
        directory: records.nested?.gitDirectory,
        expectedPluginId: "nested",
        mode: "update",
      });
      expect(updated).toMatchObject({
        targetDir: installed.targetDir,
        version: "3.0.0",
        git: { commit: nextCommit, directory },
      });
      const plan = planPluginUninstall({
        config: { plugins: { installs: records } },
        pluginId: "nested",
      });
      if (!plan.ok) {
        throw new Error(plan.error);
      }
      expect(await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval)).toEqual({
        directoryRemoved: true,
        warnings: [],
      });
      await expect(fs.access(path.resolve(installed.targetDir, "../.."))).rejects.toThrow();
      await expect(read(root.targetDir, "index.js")).resolves.toBe('export default "1.0.0";\n');
      const rootUpdated = await install({
        spec: records.demo?.spec,
        mode: "update",
        expectedPluginId: "demo",
      });
      expect(rootUpdated).toMatchObject({ targetDir: root.targetDir, version: "1.0.0" });
      expect(rootUpdated.git.directory).toBeUndefined();
      const rootPlan = planPluginUninstall({ config: plan.config, pluginId: "demo" });
      if (!rootPlan.ok) {
        throw new Error(rootPlan.error);
      }
      expect(await applyPluginUninstallDirectoryRemoval(rootPlan.directoryRemoval)).toEqual({
        directoryRemoved: true,
        warnings: [],
      });
      await expect(fs.access(root.targetDir)).rejects.toThrow();
    },
  );

  it("rejects invalid or absent package selectors without publishing a checkout", async () => {
    for (const directory of [
      "../escape",
      "plugins/../../escape",
      "/absolute",
      "C:/absolute",
      "plugins\\escape",
      "",
      "missing",
      "index.js",
    ]) {
      expect(await installPluginFromGitSpec({ spec, directory, dryRun: true })).toMatchObject({
        ok: false,
        error: expect.stringContaining("Git source directory"),
      });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects a selected symlink outside the fetched Git repository",
    async () => {
      await fs.symlink(sourceSeed, path.join(sourceDir, "escape"), "dir");
      await git(sourceDir, "add", ".");
      await git(sourceDir, "-c", "commit.gpgsign=false", "commit", "-m", "escaping selector");
      expect(
        await installPluginFromGitSpec({ spec, directory: "escape", dryRun: true }),
      ).toMatchObject({ ok: false, error: expect.stringContaining("escapes the repository") });
    },
  );

  it("installs a local-path source without sharing its Git object files", async () => {
    const commit = await head();
    const objectPath = path.join("objects", commit.slice(0, 2), commit.slice(2));
    const sourceObject = path.join(sourceDir, ".git", objectPath);
    let reviewedIndex: string | undefined;
    const installed = await install({
      spec: "git:" + path.join(sourceDir, ".git"),
      onBeforePluginArtifactCommit: async ({ stagedArtifactDir }) => {
        reviewedIndex = await read(stagedArtifactDir, "index.js");
      },
    });

    expect(reviewedIndex).toBe('export default "1.0.0";\n');
    await expect(read(installed.targetDir, "index.js")).resolves.toBe(reviewedIndex);
    expect((await fs.stat(sourceObject)).nlink).toBe(1);
    expect((await fs.stat(path.join(installed.targetDir, ".git", objectPath))).nlink).toBe(1);
    expect(await head(installed.targetDir)).toBe(commit);
  });

  it("restores the prior checkout when a deferred Git update is rolled back", async () => {
    const installed = await install();
    await fs.writeFile(path.join(installed.targetDir, "operator-note.txt"), operatorNote);
    const nextCommit = await commitPlugin("demo", "2.0.0");
    const updated = await install(
      requestDeferredPluginInstall({ spec, mode: "update" as const, expectedPluginId: "demo" }),
    );
    expect(await head(updated.targetDir)).toBe(nextCommit);
    const transaction = expectDefined(takePluginInstallTransaction(updated), "deferred update");
    await transaction.rollback();

    expect(await head(installed.targetDir)).toBe(installed.git.commit);
    await expect(read(installed.targetDir, "index.js")).resolves.toBe('export default "1.0.0";\n');
    await expect(read(installed.targetDir, "operator-note.txt")).resolves.toBe(operatorNote);
  });

  it("refuses a deferred reinstall even when the source changes plugin id", async () => {
    const installed = await install();
    const markerPath = path.join(installed.targetDir, "operator-note.txt");
    await fs.writeFile(markerPath, operatorNote);
    await commitPlugin("renamed-demo", "2.0.0");

    const result = await installPluginFromGitSpec(
      requestDeferredPluginInstall({ spec, mode: "install" as const }),
    );
    // Settle any pre-fix transaction so the failing reproduction leaves no backup behind.
    await takePluginInstallTransaction(result)?.commit();
    expect.soft(result).toEqual({
      ok: false,
      error: `plugin already exists: ${installed.targetDir} (delete it first)`,
    });
    expect.soft(await head(installed.targetDir)).toBe(installed.git.commit);
    await expect.soft(fs.readFile(markerPath, "utf8")).resolves.toBe(operatorNote);
    await expect
      .soft(read(installed.targetDir, "openclaw.plugin.json"))
      .resolves.toContain('"id":"demo"');
  });

  it("refuses default and dry-run reinstalls but allows an explicit force replacement", async () => {
    const installed = await install();
    const nextCommit = await commitPlugin("demo", "2.0.0");
    const refusal = {
      ok: false,
      error: `plugin already exists: ${installed.targetDir} (delete it first)`,
    };
    expect(await installPluginFromGitSpec({ spec })).toEqual(refusal);
    expect(await installPluginFromGitSpec({ spec, dryRun: true })).toEqual(refusal);

    const preflight = await resolvePluginInstallPreflight({
      raw: spec,
      opts: { force: true },
      allowInstallPolicyWarningPrompt: false,
    });
    if (!preflight.ok) {
      throw new Error(preflight.error);
    }
    expect(preflight.installMode).toBe("update");
    const updated = await installPluginFromGitSpec({ spec, mode: preflight.installMode });
    expect(updated).toMatchObject({ ok: true, targetDir: installed.targetDir, version: "2.0.0" });
    expect(await head(installed.targetDir)).toBe(nextCommit);
  });

  it("installs a missing update target and preserves it when a tracked update changes plugin id", async () => {
    const installed = await install({ mode: "update", expectedPluginId: "demo" });
    await commitPlugin("renamed-demo", "2.0.0");
    const updated = await installPluginFromGitSpec({
      spec,
      mode: "update",
      expectedPluginId: "demo",
    });
    expect(updated).toMatchObject({
      ok: false,
      error: "plugin id mismatch: expected demo, got renamed-demo",
    });
    expect(await head(installed.targetDir)).toBe(installed.git.commit);
  });
});
