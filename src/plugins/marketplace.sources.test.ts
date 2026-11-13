import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as jsonFiles from "../infra/json-files.js";
import {
  createMarketplaceInstallInput,
  expectMarketplaceInstallSuccess,
  writeMarketplaceManifest,
} from "./marketplace.test-support.js";
import {
  cleanupTrackedTempDirsAsync,
  makeTrackedTempDirAsync,
} from "./test-helpers/fs-fixtures.js";
import { createBundleInstallFixtureFactory } from "./test-helpers/install-fixtures.js";

const installPluginFromPathMock = vi.fn();
const installPluginInput = createMarketplaceInstallInput(installPluginFromPathMock);
const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn<typeof import("../infra/net/fetch-guard.js").fetchWithSsrFGuard>(),
);
const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());
let installPluginFromMarketplace: typeof import("./marketplace.js").installPluginFromMarketplace;
let listMarketplacePlugins: typeof import("./marketplace.js").listMarketplacePlugins;
let resolveMarketplaceInstallShortcut: typeof import("./marketplace.js").resolveMarketplaceInstallShortcut;
const tempOutsideDirs: string[] = [];
const pluginName = "frontend-design";
const relativePlugin = "./plugins/frontend-design";
const manifestFor = (source: unknown, name = pluginName) => ({ plugins: [{ name, source }] });
const remoteInstall = (marketplace = "owner/repo") =>
  installPluginFromMarketplace({ marketplace, plugin: pluginName });
const githubSource = (repo: string, ref?: string, pluginPath?: string) => ({
  kind: "github",
  repo,
  path: pluginPath,
  ref,
});
const gitSource = (url: string, ref?: string) => ({ kind: "git", url, path: undefined, ref });
const commandSuccess = { code: 0, stdout: "", stderr: "", killed: false };
const pathAlias = (target: string) => ({ source: { source: "path", path: target } });
function expectNoNetwork() {
  expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
}

vi.mock("./install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install.js")>()),
  installPluginFromPath: (...args: unknown[]) => installPluginFromPathMock(...args),
}));

vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/net/fetch-guard.js")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: { url: string; init?: RequestInit }) =>
      fetchWithSsrFGuardMock(params),
  };
});

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

beforeAll(async () => {
  ({ installPluginFromMarketplace, listMarketplacePlugins, resolveMarketplaceInstallShortcut } =
    await import("./marketplace.js"));
});

function mockSuccessfulMarketplaceInstall() {
  installPluginFromPathMock.mockResolvedValue({
    ok: true,
    pluginId: "frontend-design",
    targetDir: "/tmp/frontend-design",
  });
}

async function writeLocalMarketplaceFixture(rootDir: string) {
  const pluginDir = path.join(rootDir, "plugins", pluginName);
  await fs.mkdir(pluginDir, { recursive: true });
  return {
    pluginDir,
    manifestPath: await writeMarketplaceManifest(rootDir, manifestFor(relativePlugin)),
  };
}

function mockRemoteMarketplaceClone(params: {
  manifest: unknown;
  pluginDir?: string;
  pluginFile?: string;
  symlinkPath?: string;
}) {
  runCommandWithTimeoutMock.mockImplementationOnce(async (argv: string[]) => {
    const repoDir = argv.at(-1)!;
    if (params.pluginDir) {
      await fs.mkdir(path.join(repoDir, params.pluginDir), { recursive: true });
    }
    if (params.pluginFile) {
      const pluginFilePath = path.join(repoDir, params.pluginFile);
      await fs.mkdir(path.dirname(pluginFilePath), { recursive: true });
      await fs.writeFile(pluginFilePath, "plugin fixture");
    }
    await writeMarketplaceManifest(repoDir, params.manifest);
    if (params.symlinkPath) {
      const outsideDir = await makeTrackedTempDirAsync(
        "openclaw-marketplace-outside",
        tempOutsideDirs,
      );
      const link = path.join(repoDir, params.symlinkPath);
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(outsideDir, link);
    }
    return commandSuccess;
  });
}

function expectLocalMarketplaceInstallResult(
  result: unknown,
  pluginDir: string,
  marketplaceSource: string,
) {
  expect(installPluginInput().path).toBe(pluginDir);
  expectMarketplaceInstallSuccess(result, { marketplacePlugin: pluginName, marketplaceSource });
}

describe("marketplace plugins", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-marketplace-test-"));
  });

  afterEach(async () => {
    fetchWithSsrFGuardMock.mockClear();
    installPluginFromPathMock.mockReset();
    runCommandWithTimeoutMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await cleanupTrackedTempDirsAsync(tempOutsideDirs);
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  async function known(marketplaces: Record<string, unknown>) {
    vi.stubEnv("HOME", rootDir);
    vi.stubEnv("OPENCLAW_HOME", path.join(rootDir, "openclaw-home"));
    await fs.mkdir(path.join(rootDir, "openclaw-home"), { recursive: true });
    const registryPath = path.join(rootDir, ".claude", "plugins", "known_marketplaces.json");
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, JSON.stringify(marketplaces));
    return rootDir;
  }

  it.each([
    [
      "GitHub primary identifier and ref",
      {
        type: "github",
        source: "git",
        repo: " owner/primary ",
        url: "owner/alias",
        path: " plugins/example ",
        ref: " pinned ",
        branch: "main",
        tag: "v1",
      },
      githubSource("owner/primary", "pinned", "plugins/example"),
    ],
    [
      "Git primary identifier and branch",
      {
        type: "git",
        source: "github",
        url: " https://example.com/primary.git ",
        repo: "alias",
        ref: " ",
        branch: " main ",
        tag: "v1",
      },
      gitSource("https://example.com/primary.git", "main"),
    ],
    [
      "GitHub URL alias and tag",
      { source: "github", repo: " ", url: " owner/alias ", branch: " ", tag: " v1 " },
      githubSource("owner/alias", "v1"),
    ],
    [
      "Git repo alias and fallback discriminator",
      { type: " ", source: "git", url: 42, repo: " https://example.com/alias.git " },
      gitSource("https://example.com/alias.git"),
    ],
  ] as const)("normalizes %s in local marketplace listings", async (_label, source, expected) => {
    await writeMarketplaceManifest(rootDir, manifestFor(source, "example"));

    const result = await listMarketplacePlugins({ marketplace: rootDir });

    assert(result.ok);
    expect(result.manifest.plugins[0]?.source).toStrictEqual(expected);
    expectNoNetwork();
  });

  it.each([
    { source: { type: "github", repo: " ", url: false }, error: 'github source missing "repo"' },
    { source: { type: "git", url: null, repo: "\t" }, error: 'git source missing "url"' },
  ])("preserves $error in local marketplace listings", async ({ source, error }) => {
    const manifestPath = await writeMarketplaceManifest(rootDir, manifestFor(source, "example"));

    const result = await listMarketplacePlugins({ marketplace: rootDir });

    expect(result).toEqual({
      ok: false,
      error: `invalid marketplace entry "example" in ${manifestPath}: ${error}`,
    });
    expectNoNetwork();
  });

  it.each([false, true])("loads a symlinked manifest with oversized=%s", async (oversized) => {
    if (process.platform === "win32") {
      // Windows CI does not guarantee symlink support.
      return;
    }
    const manifestPath = path.join(rootDir, ".claude-plugin", "marketplace.json");
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    const targetPath = path.join(rootDir, "real-manifest.json");
    await fs.writeFile(
      targetPath,
      oversized
        ? Buffer.alloc(16 * 1024 * 1024 + 1, "x")
        : JSON.stringify(manifestFor(".", "symlinked-plugin")),
    );
    await fs.symlink(targetPath, manifestPath);

    const result = await listMarketplacePlugins({ marketplace: rootDir });

    if (oversized) {
      expect(result).toEqual({ ok: false, error: "Marketplace manifest too large" });
    } else {
      assert(result.ok);
      expect(result.manifest.plugins).toHaveLength(1);
    }
  });

  it("preserves the logical local install path instead of canonicalizing it", async () => {
    const { pluginDir, manifestPath } = await writeLocalMarketplaceFixture(rootDir);
    mockSuccessfulMarketplaceInstall();

    const result = await installPluginFromMarketplace({
      marketplace: manifestPath,
      plugin: "frontend-design",
    });

    expectLocalMarketplaceInstallResult(result, pluginDir, manifestPath);
    expect(installPluginInput().installPolicyRequest).toMatchObject({
      kind: "plugin-dir",
      requestedSpecifier: `frontend-design@${manifestPath}`,
      source: { kind: "local-path", authority: "user", mutable: true, network: false },
    });
  });

  it.each([
    ["install", "frontend-design"],
    ["update", " frontend-design "],
  ] as const)(
    "rejects only ambiguous marketplace selections during %s",
    async (mode, duplicateName) => {
      const { pluginDir, manifestPath } = await writeLocalMarketplaceFixture(rootDir);
      await writeMarketplaceManifest(rootDir, {
        plugins: [
          { name: pluginName, source: relativePlugin },
          { name: duplicateName, source: "./plugins/other" },
          { name: "Frontend-design", source: relativePlugin },
        ],
      });
      mockSuccessfulMarketplaceInstall();

      await expect(listMarketplacePlugins({ marketplace: manifestPath })).resolves.toMatchObject({
        ok: true,
        manifest: {
          plugins: [{ name: pluginName }, { name: pluginName }, { name: "Frontend-design" }],
        },
      });
      await expect(
        installPluginFromMarketplace({ marketplace: manifestPath, plugin: pluginName, mode }),
      ).resolves.toEqual({
        ok: false,
        error: `plugin "${pluginName}" is ambiguous in marketplace ${manifestPath}: 2 entries share this name; remove or rename the duplicate entries`,
      });
      expect(installPluginFromPathMock).not.toHaveBeenCalled();

      await expect(
        installPluginFromMarketplace({
          marketplace: manifestPath,
          plugin: "Frontend-design",
          mode,
        }),
      ).resolves.toMatchObject({ ok: true, marketplacePlugin: "Frontend-design" });
      expect(installPluginInput()).toMatchObject({ path: pluginDir, mode });
      expectNoNetwork();
    },
  );

  it("does not publish a marketplace plugin after authority closes during artifact review", async () => {
    const { pluginDir, extensionsDir } = createBundleInstallFixtureFactory(() => rootDir)({
      bundleFormat: "claude",
      name: "Guarded Bundle",
    });
    const manifestPath = await writeMarketplaceManifest(
      rootDir,
      manifestFor("./plugin-src", "guarded-bundle"),
    );
    const { installPluginFromPath } = await import("./install-package.js");
    installPluginFromPathMock.mockImplementationOnce(installPluginFromPath);
    let authorityActive = true;
    const result = await installPluginFromMarketplace({
      marketplace: manifestPath,
      plugin: "guarded-bundle",
      extensionsDir,
      onBeforePluginArtifactCommit: async () => {
        authorityActive = false;
      },
      beforePersistentApply: () => {
        if (!authorityActive) {
          throw new Error("plugin installation authority closed");
        }
      },
    });

    expect(authorityActive).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("plugin installation authority closed"),
    });
    await expect(fs.stat(path.join(extensionsDir, "guarded-bundle"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(pluginDir)).resolves.toBeDefined();
  });

  it("resolves Claude-style plugin@marketplace shortcuts from known_marketplaces.json", async () => {
    await known({ fixture: { installLocation: rootDir } });
    expect(await resolveMarketplaceInstallShortcut("tool@fixture")).toEqual({
      ok: true,
      plugin: "tool",
      marketplaceSource: "fixture",
    });
  });

  it.each([
    ["loop", { loop: pathAlias("loop") }, "loop -> loop"],
    ["alpha", { alpha: pathAlias("beta"), beta: pathAlias("alpha") }, "alpha -> beta -> alpha"],
  ] as const)(
    "rejects known marketplace alias cycles from %s",
    async (marketplace, marketplaces, cycle) => {
      await known(marketplaces);
      const registryRead = vi.spyOn(jsonFiles, "tryReadJson");
      for (let read = 0; read <= Object.keys(marketplaces).length; read += 1) {
        registryRead.mockResolvedValueOnce(marketplaces);
      }
      // Bound the unfixed recursive loader so the regression never leaves a runaway task.
      registryRead.mockResolvedValueOnce({});
      try {
        expect(await listMarketplacePlugins({ marketplace })).toEqual({
          ok: false,
          error: `known marketplace source cycle: ${cycle}`,
        });
        expect(registryRead).toHaveBeenCalledTimes(1);
        expectNoNetwork();
      } finally {
        registryRead.mockRestore();
      }
    },
  );

  it("resolves independent known marketplace alias calls from one registry snapshot each", async () => {
    const homeDir = await known({});
    const marketplaceRoot = path.join(homeDir, "known-marketplace");
    const { pluginDir } = await writeLocalMarketplaceFixture(marketplaceRoot);
    await fs.writeFile(
      path.join(homeDir, ".claude", "plugins", "known_marketplaces.json"),
      JSON.stringify({
        alpha: pathAlias("beta"),
        beta: { installLocation: marketplaceRoot, ...pathAlias("alpha") },
      }),
    );
    mockSuccessfulMarketplaceInstall();
    const registryRead = vi.spyOn(jsonFiles, "tryReadJson");

    try {
      const listed = await listMarketplacePlugins({ marketplace: "alpha" });
      const installed = await installPluginFromMarketplace({
        marketplace: "alpha",
        plugin: "frontend-design",
      });

      expect(listed).toMatchObject({ ok: true, sourceLabel: "beta" });
      expectLocalMarketplaceInstallResult(installed, pluginDir, "alpha");
      expect(registryRead).toHaveBeenCalledTimes(2);
      expectNoNetwork();
    } finally {
      registryRead.mockRestore();
    }
  });

  it("preserves ordinary source fallback for an invalid known marketplace alias", async () => {
    await known({ broken: { source: { source: "path" } } });
    expect(await listMarketplacePlugins({ marketplace: "broken" })).toEqual({
      ok: false,
      error: "unsupported marketplace source: broken",
    });
    expectNoNetwork();
  });

  it.each([
    ["directory", "", ""],
    ["archive", ".tgz", ""],
    ["immutable archive", ".tgz", "0123456789abcdef0123456789abcdef01234567"],
  ])("installs remote %s paths with source policy", async (_label, extension, commit) => {
    const pluginPath = path.join("plugins", `${pluginName}${extension}`);
    const marketplace = `owner/repo${commit ? `#${commit}` : ""}`;
    mockRemoteMarketplaceClone({
      ...(extension ? { pluginFile: pluginPath } : { pluginDir: pluginPath }),
      manifest: manifestFor(`${relativePlugin}${extension}`),
    });
    if (commit) {
      runCommandWithTimeoutMock.mockResolvedValueOnce(commandSuccess);
    }
    mockSuccessfulMarketplaceInstall();
    expectMarketplaceInstallSuccess(await remoteInstall(marketplace), {
      marketplacePlugin: pluginName,
      marketplaceSource: marketplace,
    });
    expect(String(installPluginInput().path)).toMatch(
      extension
        ? /[\\/]repo[\\/]plugins[\\/]frontend-design\.tgz$/
        : /[\\/]repo[\\/]plugins[\\/]frontend-design$/,
    );
    expect(installPluginInput().installPolicyRequest).toMatchObject({
      kind: extension ? "plugin-archive" : "plugin-git",
      requestedSpecifier: `${pluginName}@${marketplace}`,
      source: {
        kind: extension ? "archive" : "git",
        authority: "third-party",
        mutable: !commit,
        network: true,
      },
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects remote marketplace plugin paths that resolve through symlinks outside the cloned repo",
    async () => {
      mockRemoteMarketplaceClone({
        symlinkPath: "plugins/evil-link",
        manifest: manifestFor("./plugins/evil-link"),
      });

      const result = await remoteInstall();

      expect(result).toEqual({
        ok: false,
        error:
          'invalid marketplace entry "frontend-design" in owner/repo: ' +
          "plugin source escapes marketplace root: ./plugins/evil-link",
      });
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      { type: "git", url: "https://evil.example/repo.git" },
      "remote marketplaces may not use git plugin sources",
    ],
    [
      { type: "path", path: "/tmp/frontend-design" },
      "remote marketplaces may only use relative plugin paths",
    ],
    [
      { type: "path", path: "https://evil.example/plugin.tgz" },
      "remote marketplaces may not use HTTP(S) plugin paths",
    ],
    [
      { type: "path", path: "plugins/missing-plugin" },
      "plugin source not found in marketplace root: plugins/missing-plugin",
    ],
  ] as const)("rejects remote source %j: %s", async (source, error) => {
    mockRemoteMarketplaceClone({ manifest: manifestFor(source) });
    expect(await listMarketplacePlugins({ marketplace: "owner/repo" })).toEqual({
      ok: false,
      error: `invalid marketplace entry "frontend-design" in owner/repo: ${error}`,
    });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
  });
});
