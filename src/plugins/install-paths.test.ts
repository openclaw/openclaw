import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  resolveDefaultPluginExtensionsDir,
  resolveDefaultPluginGitDir,
  resolveDefaultPluginNpmDir,
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmGenerationProjectDirPrefix,
} from "./install-paths.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";
import {
  resolveInstalledPluginIndexStateDatabaseOptions,
  resolveInstalledPluginIndexStorePath,
} from "./installed-plugin-index-store-path.js";

const artifactDirs = [
  [resolveDefaultPluginExtensionsDir, "extensions"],
  [resolveDefaultPluginNpmDir, "npm"],
  [resolveDefaultPluginGitDir, "git"],
] as const;

function expectRoots(env: NodeJS.ProcessEnv, root: string) {
  for (const [resolve, kind] of artifactDirs) {
    expect(resolve(env)).toBe(`${root}/${kind}`);
  }
  expect(resolveInstalledPluginIndexStorePath({ env })).toBe(`${root}/state/openclaw.sqlite`);
  expect(resolveInstalledPluginIndexStateDatabaseOptions({ env }).env?.OPENCLAW_STATE_DIR).toBe(
    root,
  );
}

describe("plugin install root context", () => {
  it.each([
    { env: { OPENCLAW_HOME: "/operator/home" }, root: "/operator/home/.openclaw" },
    { env: { OPENCLAW_CONFIG_PATH: "/operator/config/openclaw.json" }, root: "/operator/config" },
  ])("resolves artifact directories without probing state locations ($root)", ({ env, root }) => {
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    try {
      for (const [resolve, kind] of artifactDirs) {
        expect(resolve(env, () => "/unused-home")).toBe(path.resolve(root, kind));
      }
      expect(exists).not.toHaveBeenCalled();
    } finally {
      exists.mockRestore();
    }
  });

  it("keeps discovery roots on the operator install while runtime state is redirected", async () => {
    const operatorRoots = resolvePluginInstallRoots(
      { OPENCLAW_STATE_DIR: "/operator/openclaw" },
      () => "/unused-home",
    );
    const redirectedEnv = { OPENCLAW_STATE_DIR: "/tmp/ephemeral-run" };

    await withPluginInstallRoots(operatorRoots, async () => {
      await Promise.resolve();
      expectRoots(redirectedEnv, "/operator/openclaw");
    });

    expectRoots(redirectedEnv, "/tmp/ephemeral-run");
  });

  it("isolates concurrent install-root scopes", async () => {
    const resolveScopedRoot = async (stateDir: string) => {
      const roots = resolvePluginInstallRoots({ OPENCLAW_STATE_DIR: stateDir });
      return await withPluginInstallRoots(roots, async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        return resolveDefaultPluginExtensionsDir({ OPENCLAW_STATE_DIR: "/redirected" });
      });
    };

    await expect(
      Promise.all([resolveScopedRoot("/operator/one"), resolveScopedRoot("/operator/two")]),
    ).resolves.toEqual(["/operator/one/extensions", "/operator/two/extensions"]);
  });
});

it("keeps generation project names compact for nested Windows runtime binaries", () => {
  const packageName = "@openclaw/codex";
  const projectDir = resolvePluginNpmGenerationProjectDir({
    npmDir: String.raw`C:\Users\Administrator\.openclaw\npm`,
    packageName,
    generationKey: `${packageName}\n2026.6.10\n${packageName}@2026.6.10\nsha512-test-integrity\ncodexshasum`,
  });
  const projectName = path.basename(projectDir);

  expect(projectName).toMatch(
    /^openclaw-codex-[a-f0-9]{10}__openclaw-generation__g-[a-f0-9]{16}$/u,
  );
  expect(projectName.length).toBeLessThanOrEqual(66);
  expect(projectName).toMatch(
    new RegExp(`^${resolvePluginNpmGenerationProjectDirPrefix(packageName)}`, "u"),
  );

  const nestedCodexBinaryPath = path.win32.join(
    String.raw`C:\Users\Administrator\.openclaw\npm\projects`,
    projectName,
    "node_modules/@openclaw/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
  );
  expect(nestedCodexBinaryPath.length).toBeLessThan(260);
});
