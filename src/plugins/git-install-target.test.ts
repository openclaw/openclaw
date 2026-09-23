import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

  async function git(cwd: string, ...args: string[]) {
    const result = await runCommandWithTimeout(["git", ...args], { cwd, timeoutMs: 10_000 });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  async function commitPluginAt(root: string, pluginId: string, version: string) {
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
    return await git(root, "rev-parse", "HEAD");
  }

  async function commitPlugin(pluginId: string, version: string) {
    return await commitPluginAt(sourceDir, pluginId, version);
  }

  beforeAll(async () => {
    sourceSeed = tempDirs.make("openclaw-git-install-seed-");
    await git(sourceSeed, "init", "--initial-branch=main");
    await git(sourceSeed, "config", "user.name", "OpenClaw Test");
    await git(sourceSeed, "config", "user.email", "test@openclaw.invalid");
    await commitPluginAt(sourceSeed, "demo", "1.0.0");
  });

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "git-install-target" });
    const globalConfig = await state.writeText("global-npmrc", "");
    vi.stubEnv("NPM_CONFIG_GLOBALCONFIG", globalConfig);
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
      const defaultCommit = await git(sourceDir, "rev-parse", "HEAD");
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
      const result = await installPluginFromGitSpec({
        spec: `${spec}${ref ? `#${ref}` : ""}`,
        expectedPluginId: "demo",
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
      const expectedCommit = kind === "default" ? defaultCommit : featureCommit;
      const expectedVersion = kind === "default" ? "1.0.0" : "2.0.0";
      expect(result.version).toBe(expectedVersion);
      expect(result.git).toMatchObject({ ref, commit: expectedCommit });
      expect(await git(result.targetDir, "rev-parse", "HEAD")).toBe(expectedCommit);
      await expect(fs.readFile(path.join(result.targetDir, "index.js"), "utf8")).resolves.toBe(
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
        expect(await git(result.targetDir, "rev-parse", "HEAD")).toBe(nextCommit);
      }
    },
  );

  it.each([
    { pluginId: "demo", deferred: false },
    { pluginId: "renamed-demo", deferred: false },
    { pluginId: "demo", deferred: true },
    { pluginId: "renamed-demo", deferred: true },
  ])(
    "refuses a reinstall with id=$pluginId and deferred=$deferred",
    async ({ pluginId, deferred }) => {
      const installed = await installPluginFromGitSpec({ spec });
      if (!installed.ok) {
        throw new Error(installed.error);
      }
      const markerPath = path.join(installed.targetDir, "operator-note.txt");
      await fs.writeFile(markerPath, "keep this checkout");
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
      expect.soft(await git(installed.targetDir, "rev-parse", "HEAD")).toBe(installed.git.commit);
      await expect.soft(fs.readFile(markerPath, "utf8")).resolves.toBe("keep this checkout");
      await expect
        .soft(fs.readFile(path.join(installed.targetDir, "openclaw.plugin.json"), "utf8"))
        .resolves.toContain('"id":"demo"');
    },
  );

  it("refuses default and dry-run reinstalls but allows an explicit force replacement", async () => {
    const installed = await installPluginFromGitSpec({ spec });
    if (!installed.ok) {
      throw new Error(installed.error);
    }
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
    expect(await git(installed.targetDir, "rev-parse", "HEAD")).toBe(nextCommit);
  });

  it("installs a missing update target and preserves it when a tracked update changes plugin id", async () => {
    const installed = await installPluginFromGitSpec({
      spec,
      mode: "update",
      expectedPluginId: "demo",
    });
    if (!installed.ok) {
      throw new Error(installed.error);
    }
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
    expect(await git(installed.targetDir, "rev-parse", "HEAD")).toBe(installed.git.commit);
  });
});
