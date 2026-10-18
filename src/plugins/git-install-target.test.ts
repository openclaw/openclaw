import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePluginInstallPreflight } from "../cli/plugins-install-preflight.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { installPluginFromGitSpec } from "./git-install.js";
import {
  requestDeferredPluginInstall,
  resolvePluginInstallTransaction,
} from "./install-transaction.js";

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
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "git-fixture", version, openclaw: { extensions: ["index.js"] } }),
    );
    await fs.writeFile(
      path.join(root, "openclaw.plugin.json"),
      JSON.stringify({ id: pluginId, configSchema: { type: "object", properties: {} } }),
    );
    await fs.writeFile(path.join(root, "index.js"), `export default ${JSON.stringify(version)};\n`);
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

  it.each(["branch", "tag", "annotated-tag", "commit", "short-commit", "default"] as const)(
    "installs the requested %s revision from a real Git repository",
    async (kind) => {
      const defaultCommit = await head();
      await git(sourceDir, "switch", "-c", "feature/demo");
      const featureCommit = await commitPlugin("demo", "2.0.0");
      await git(sourceDir, "tag", "v2.0.0");
      await git(sourceDir, "-c", "tag.gpgsign=false", "tag", "-a", "release", "-m", "release");
      await git(sourceDir, "switch", "main");
      const refs = {
        branch: "feature/demo",
        tag: "v2.0.0",
        "annotated-tag": "release",
        commit: featureCommit,
        "short-commit": featureCommit.slice(0, 12),
        default: undefined,
      };
      const ref = refs[kind];
      const result = await install({
        spec: `${spec}${ref ? `#${ref}` : ""}`,
        expectedPluginId: "demo",
      });
      const expectedCommit = kind === "default" ? defaultCommit : featureCommit;
      const expectedVersion = kind === "default" ? "1.0.0" : "2.0.0";
      expect(result).toMatchObject({
        version: expectedVersion,
        git: { ref, commit: expectedCommit },
      });
      expect(await head(result.targetDir)).toBe(expectedCommit);
      await expect(read(result.targetDir, "index.js")).resolves.toBe(
        `export default ${JSON.stringify(expectedVersion)};\n`,
      );
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
    const transaction = expectDefined(resolvePluginInstallTransaction(updated), "deferred update");
    await transaction.rollback();

    expect(await head(installed.targetDir)).toBe(installed.git.commit);
    await expect(read(installed.targetDir, "index.js")).resolves.toBe('export default "1.0.0";\n');
    await expect(read(installed.targetDir, "operator-note.txt")).resolves.toBe(operatorNote);
  });

  it.each([
    { pluginId: "demo", deferred: false },
    { pluginId: "renamed-demo", deferred: false },
    { pluginId: "demo", deferred: true },
    { pluginId: "renamed-demo", deferred: true },
  ])(
    "refuses a reinstall with id=$pluginId and deferred=$deferred",
    async ({ pluginId, deferred }) => {
      const installed = await install();
      const markerPath = path.join(installed.targetDir, "operator-note.txt");
      await fs.writeFile(markerPath, operatorNote);
      await commitPlugin(pluginId, "2.0.0");

      const options = { spec, mode: "install" as const };
      const result = await installPluginFromGitSpec(
        deferred ? requestDeferredPluginInstall(options) : options,
      );
      // Settle any pre-fix transaction so the failing reproduction leaves no backup behind.
      await resolvePluginInstallTransaction(result)?.commit();
      expect.soft(result).toEqual({
        ok: false,
        error: `plugin already exists: ${installed.targetDir} (delete it first)`,
      });
      expect.soft(await head(installed.targetDir)).toBe(installed.git.commit);
      await expect.soft(fs.readFile(markerPath, "utf8")).resolves.toBe(operatorNote);
      await expect
        .soft(read(installed.targetDir, "openclaw.plugin.json"))
        .resolves.toContain('"id":"demo"');
    },
  );

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
