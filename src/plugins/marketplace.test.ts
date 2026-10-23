import "../test-utils/prepare-compiled-subprocesses.js";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as jsonFiles from "../infra/json-files.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
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

vi.mock("./install.js", () => ({
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

vi.mock("../process/exec.js", () => ({
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
    version: "0.1.0",
    extensions: ["index.ts"],
  });
}

async function writeRemoteMarketplaceFixture(params: {
  repoDir: string;
  manifest: unknown;
  pluginDir?: string;
  pluginFile?: string;
}) {
  if (params.pluginDir) {
    await fs.mkdir(path.join(params.repoDir, params.pluginDir), { recursive: true });
  }
  if (params.pluginFile) {
    const pluginFilePath = path.join(params.repoDir, params.pluginFile);
    await fs.mkdir(path.dirname(pluginFilePath), { recursive: true });
    await fs.writeFile(pluginFilePath, "plugin fixture");
  }
  await writeMarketplaceManifest(params.repoDir, params.manifest);
}

async function writeLocalMarketplaceFixture(rootDir: string) {
  const pluginDir = path.join(rootDir, "plugins", pluginName);
  await fs.mkdir(pluginDir, { recursive: true });
  return {
    pluginDir,
    manifestPath: await writeMarketplaceManifest(rootDir, manifestFor(relativePlugin)),
  };
}

async function withKnownMarketplaceRegistry<T>(
  marketplaces: Record<string, unknown> | ((homeDir: string) => Record<string, unknown>),
  run: (homeDir: string) => Promise<T>,
): Promise<T> {
  return await withTempDir("openclaw-marketplace-known-", async (homeDir) => {
    const openClawHome = path.join(homeDir, "openclaw-home");
    const registryPath = path.join(homeDir, ".claude", "plugins", "known_marketplaces.json");
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.mkdir(openClawHome, { recursive: true });
    await fs.writeFile(
      registryPath,
      JSON.stringify(typeof marketplaces === "function" ? marketplaces(homeDir) : marketplaces),
    );
    return await withEnvAsync({ HOME: homeDir, OPENCLAW_HOME: openClawHome }, async () =>
      run(homeDir),
    );
  });
}

function mockRemoteMarketplaceClone(params: {
  manifest: unknown;
  pluginDir?: string;
  pluginFile?: string;
  symlinkPath?: string;
}) {
  runCommandWithTimeoutMock.mockImplementationOnce(async (argv: string[]) => {
    const repoDir = argv.at(-1);
    expect(typeof repoDir).toBe("string");
    await writeRemoteMarketplaceFixture({
      repoDir: repoDir as string,
      ...params,
    });
    if (params.symlinkPath) {
      const outsideDir = await makeTrackedTempDirAsync(
        "openclaw-marketplace-outside",
        tempOutsideDirs,
      );
      const link = path.join(repoDir as string, params.symlinkPath);
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(outsideDir, link);
    }
    return commandSuccess;
  });
}

function expectRemoteCloneCommand() {
  expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
  const [argv, options] = runCommandWithTimeoutMock.mock.calls[0] ?? [];
  expect(Array.isArray(argv)).toBe(true);
  expect((argv as unknown[]).slice(0, 5)).toEqual([
    "git",
    "clone",
    "--depth",
    "1",
    "https://github.com/owner/repo.git",
  ]);
  expect(typeof (argv as unknown[])[5]).toBe("string");
  expect(options).toEqual({ timeoutMs: 120_000 });
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
  afterEach(async () => {
    fetchWithSsrFGuardMock.mockClear();
    installPluginFromPathMock.mockReset();
    runCommandWithTimeoutMock.mockReset();
    vi.unstubAllGlobals();
    await cleanupTrackedTempDirsAsync(tempOutsideDirs);
  });

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
    [
      "GitHub missing optional fields",
      { type: "github", repo: "owner/repo" },
      githubSource("owner/repo"),
    ],
    [
      "Git explicit ref before branch and tag",
      {
        type: "git",
        url: "https://example.com/repo.git",
        ref: " pinned ",
        branch: "main",
        tag: "v1",
      },
      gitSource("https://example.com/repo.git", "pinned"),
    ],
  ] as const)("normalizes %s in local marketplace listings", async (_label, source, expected) => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      await writeMarketplaceManifest(rootDir, { plugins: [{ name: "example", source }] });

      const result = await listMarketplacePlugins({ marketplace: rootDir });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(result.manifest.plugins[0]?.source).toStrictEqual(expected);
      expectNoNetwork();
    });
  });

  it.each([
    { source: { type: "github", repo: " ", url: false }, error: 'github source missing "repo"' },
    { source: { type: "git", url: null, repo: "\t" }, error: 'git source missing "url"' },
  ])("preserves $error in local marketplace listings", async ({ source, error }) => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const manifestPath = await writeMarketplaceManifest(rootDir, {
        plugins: [{ name: "example", source }],
      });

      const result = await listMarketplacePlugins({ marketplace: rootDir });

      expect(result).toEqual({
        ok: false,
        error: `invalid marketplace entry "example" in ${manifestPath}: ${error}`,
      });
      expectNoNetwork();
    });
  });

  it.each([false, true])("loads a symlinked manifest with oversized=%s", async (oversized) => {
    if (process.platform === "win32") {
      // Windows CI does not guarantee symlink support.
      return;
    }
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
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
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error(result.error);
        }
        expect(result.manifest.plugins).toHaveLength(1);
      }
    });
  });

  it("preserves the logical local install path instead of canonicalizing it", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const canonicalRootDir = await fs.realpath(rootDir);
      const canonicalPluginDir = path.join(canonicalRootDir, "plugins", "frontend-design");
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
      if (canonicalPluginDir !== pluginDir) {
        expect(
          installPluginFromPathMock.mock.calls.some(
            ([input]) => (input as { path?: unknown } | undefined)?.path === canonicalPluginDir,
          ),
        ).toBe(false);
      }
    });
  });

  it.each([
    ["install", "frontend-design"],
    ["update", " frontend-design "],
  ] as const)(
    "rejects only ambiguous marketplace selections during %s",
    async (mode, duplicateName) => {
      await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
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
      });
    },
  );

  it("does not publish a marketplace plugin after authority closes during artifact review", async () => {
    await withTempDir("openclaw-marketplace-guard-", async (rootDir) => {
      const { pluginDir, extensionsDir } = createBundleInstallFixtureFactory(() => rootDir)({
        bundleFormat: "claude",
        name: "Guarded Bundle",
      });
      const manifestPath = await writeMarketplaceManifest(rootDir, {
        plugins: [{ name: "guarded-bundle", source: "./plugin-src" }],
      });
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
  });

  it("resolves Claude-style plugin@marketplace shortcuts from known_marketplaces.json", async () => {
    await withKnownMarketplaceRegistry(
      (homeDir) => ({
        "claude-plugins-official": {
          source: { source: "github", repo: "anthropics/claude-plugins-official" },
          installLocation: path.join(homeDir, ".claude", "plugins", "marketplaces", "official"),
        },
      }),
      async () => {
        expect(
          await resolveMarketplaceInstallShortcut("superpowers@claude-plugins-official"),
        ).toEqual({
          ok: true,
          plugin: "superpowers",
          marketplaceSource: "claude-plugins-official",
        });
      },
    );
  });

  const cyclicKnownMarketplaces = [
    {
      label: "self-referential",
      marketplace: "loop",
      marketplaces: {
        loop: pathAlias("loop"),
      },
      cycle: "loop -> loop",
    },
    {
      label: "two-marketplace",
      marketplace: "alpha",
      marketplaces: {
        alpha: pathAlias("beta"),
        beta: pathAlias("alpha"),
      },
      cycle: "alpha -> beta -> alpha",
    },
  ] as const;

  it.each(cyclicKnownMarketplaces)(
    "rejects a $label known marketplace alias cycle while listing",
    async ({ marketplace, marketplaces, cycle }) => {
      await withKnownMarketplaceRegistry(marketplaces, async () => {
        const registryRead = vi.spyOn(jsonFiles, "tryReadJson");
        for (let read = 0; read <= Object.keys(marketplaces).length; read += 1) {
          registryRead.mockResolvedValueOnce(marketplaces);
        }
        // Bound the unfixed recursive loader so the regression never leaves a runaway task.
        registryRead.mockResolvedValueOnce({});

        try {
          const result = await listMarketplacePlugins({ marketplace });

          expect(result).toEqual({
            ok: false,
            error: `known marketplace source cycle: ${cycle}`,
          });
          expect(registryRead).toHaveBeenCalledTimes(1);
          expectNoNetwork();
        } finally {
          registryRead.mockRestore();
        }
      });
    },
  );

  it("resolves independent known marketplace alias calls from one registry snapshot each", async () => {
    await withKnownMarketplaceRegistry({}, async (homeDir) => {
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
  });

  it("preserves ordinary source fallback for an invalid known marketplace alias", async () => {
    await withKnownMarketplaceRegistry({ broken: { source: { source: "path" } } }, async () => {
      const result = await listMarketplacePlugins({ marketplace: "broken" });

      expect(result).toEqual({ ok: false, error: "unsupported marketplace source: broken" });
      expectNoNetwork();
    });
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
    if (commit) {
      expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(2);
      expect(runCommandWithTimeoutMock.mock.calls.map(([argv]) => argv)).toEqual([
        ["git", "clone", "https://github.com/owner/repo.git", expect.any(String)],
        ["git", "switch", "--detach", "--", commit],
      ]);
    } else {
      expectRemoteCloneCommand();
    }
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

describe("marketplace archive downloads", () => {
  async function listMarketplaceDownloadTempDirs(): Promise<string[]> {
    const entries = await fs.readdir(resolvePreferredOpenClawTmpDir(), { withFileTypes: true });
    return entries
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith("openclaw-marketplace-download-"),
      )
      .map((entry) => entry.name)
      .toSorted();
  }

  function expectFetchDownloadCall(url = "https://example.com/frontend-design.tgz") {
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]).toMatchObject({
      url,
      timeoutMs: 120_000,
      auditContext: "marketplace-plugin-download",
    });
  }

  const archiveUrl = "https://example.com/frontend-design.tgz";
  let rootDir: string;
  let manifestPath: string;
  let nativeMode: ReturnType<typeof getFsSafeNativeConfig>["mode"];
  function respond(
    response: Response,
    finalUrl = archiveUrl,
    release: () => Promise<void> = vi.fn(async () => undefined),
  ) {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, finalUrl, release });
    return release;
  }

  function streamingResponse(cancel: () => void | Promise<void>, status = 200) {
    return new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(Buffer.from("archive fixture")),
        cancel,
      }),
      { status },
    );
  }

  function fakeResponse(kind = "stream") {
    const cancel = vi.fn(async () => undefined);
    const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
    const reader = { read: vi.fn(), cancel: vi.fn(async () => undefined), releaseLock: vi.fn() };
    const response = {
      ok: true,
      status: 200,
      arrayBuffer,
      headers: new Headers(
        kind.endsWith("length")
          ? { "content-length": kind === "malformed length" ? "1e9" : "268435457" }
          : {},
      ),
      body: { getReader: () => reader, cancel },
    } as unknown as Response;
    return { response, reader, cancel, arrayBuffer };
  }

  function expectDownloadFailure(result: unknown, error: string) {
    expect(result).toEqual({ ok: false, error: `failed to download ${archiveUrl}: ${error}` });
    expect(installPluginFromPathMock).not.toHaveBeenCalled();
  }

  async function install(timeoutMs?: number, source = archiveUrl) {
    manifestPath = await writeMarketplaceManifest(rootDir, {
      plugins: [{ name: "frontend-design", source }],
    });
    return installPluginFromMarketplace({
      marketplace: manifestPath,
      plugin: "frontend-design",
      timeoutMs,
    });
  }

  beforeEach(async () => {
    nativeMode = getFsSafeNativeConfig().mode;
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-marketplace-test-"));
  });
  afterEach(async () => {
    fetchWithSsrFGuardMock.mockClear();
    installPluginFromPathMock.mockReset();
    vi.restoreAllMocks();
    configureFsSafeNative({ mode: nativeMode });
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it.each([
    ["empty", "empty response body"],
    ["HTTP", "HTTP 503"],
    ["malformed length", "invalid content-length header: 1e9"],
    ["oversized length", "download too large: 268435457 bytes (limit: 268435456 bytes)"],
    ["drive-relative filename", "invalid download filename"],
  ] as const)("rejects %s responses before installing an archive", async (kind, error) => {
    const fixture = fakeResponse(kind);
    const response =
      kind === "HTTP"
        ? streamingResponse(fixture.cancel, 503)
        : kind === "empty"
          ? new Response(null)
          : kind === "drive-relative filename"
            ? new Response("tgz-bytes")
            : fixture.response;
    const release = respond(
      response,
      kind === "drive-relative filename" ? "https://cdn.example.com/C:plugin.tgz" : archiveUrl,
    );
    expectDownloadFailure(await install(), error);
    expectFetchDownloadCall();
    expect(release).toHaveBeenCalledTimes(1);
    if (kind === "HTTP" || kind.endsWith("length")) {
      expect(fixture.cancel).toHaveBeenCalledTimes(1);
    }
    if (kind.endsWith("length")) {
      expect(fixture.reader.read).not.toHaveBeenCalled();
      expect(fixture.reader.cancel).not.toHaveBeenCalled();
    }
  });

  it("downloads archives with NaN timeout and failing release", async () => {
    const release = vi.fn(async () => {
      throw new Error("dispatcher close failed");
    });
    respond(new Response("tgz-bytes"), "https://cdn.example.com/releases/12345", release);
    installPluginFromPathMock.mockImplementation(
      async ({ path: archivePath }: { path: string }) => {
        expect(await fs.readFile(archivePath, "utf8")).toBe("tgz-bytes");
        if (process.platform !== "win32") {
          expect((await fs.stat(archivePath)).mode & 0o777).toBe(0o666 & ~process.umask());
        }
        return { ok: true, pluginId: "frontend-design" };
      },
    );
    expectMarketplaceInstallSuccess(await install(Number.NaN), {
      marketplacePlugin: "frontend-design",
      marketplaceSource: manifestPath,
    });
    expectFetchDownloadCall();
    expect(String(installPluginInput().path)).toMatch(/[\\/]frontend-design\.tgz$/);
    expect(installPluginInput().installPolicyRequest).toMatchObject({
      kind: "plugin-archive",
      requestedSpecifier: `frontend-design@${manifestPath}`,
      source: { kind: "archive", authority: "third-party", mutable: true, network: true },
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["oversized", "file exceeds limit of 268435456 bytes (got at least 268435457)"],
    ["interrupted", "archive stream failed"],
  ] as const)("cancels and cleans up an %s archive stream", async (kind, error) => {
    const beforeTempDirs = await listMarketplaceDownloadTempDirs();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          kind === "oversized"
            ? new Uint8Array(256 * 1024 * 1024 + 1)
            : Buffer.from("partial archive"),
        );
      },
      pull(controller) {
        if (kind === "interrupted") {
          controller.error(new Error(error));
        }
      },
      cancel,
    });
    const response = new Response(body);
    const arrayBuffer = vi.spyOn(response, "arrayBuffer");
    const release = respond(response, "https://cdn.example.com/releases/frontend-design.tgz");
    expectDownloadFailure(await install(), error);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    if (kind === "oversized") {
      expect(cancel).toHaveBeenCalledTimes(1);
    }
    expect(await listMarketplaceDownloadTempDirs()).toEqual(beforeTempDirs);
  });
  it.each(["open fails", "write makes no progress"])("cleans up after %s", async (failure) => {
    configureFsSafeNative({ mode: "off" });
    const cancel = vi.fn();
    const response = streamingResponse(cancel);
    const release = respond(response);
    const open = fs.open.bind(fs);
    const attemptedPaths: string[] = [];
    const downloads: Awaited<ReturnType<typeof fs.open>>[] = [];
    vi.spyOn(fs, "open").mockImplementation(async (pathname, flags, mode) => {
      const isDownload =
        String(pathname).includes("openclaw-marketplace-download-") &&
        (flags === "wx" || (typeof flags === "number" && (flags & constants.O_WRONLY) !== 0));
      if (!isDownload) {
        return open(pathname, flags, mode);
      }
      attemptedPaths.push(String(pathname));
      if (failure === "open fails") {
        throw Object.assign(new Error("download destination unavailable"), { code: "EACCES" });
      }
      const handle = await open(pathname, flags, mode);
      downloads.push(handle);
      vi.spyOn(handle, "write").mockImplementation(async (buffer) => ({ bytesWritten: 0, buffer }));
      return handle;
    });

    expect(await install()).toEqual({
      ok: false,
      error: expect.stringContaining(
        failure === "open fails"
          ? "download destination unavailable"
          : "file write made no progress",
      ),
    });
    expect(attemptedPaths).toHaveLength(1);
    for (const handle of downloads) {
      await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    }
    await expect(fs.stat(path.dirname(attemptedPaths[0]!))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(installPluginFromPathMock).not.toHaveBeenCalled();
  });

  it.each(["invalid URL", "guard rejection"] as const)("sanitizes %s errors", async (failure) => {
    const invalid = failure === "invalid URL";
    if (!invalid) {
      fetchWithSsrFGuardMock.mockRejectedValueOnce(
        new Error(
          "blocked\n\u001b[31mAuthorization: Bearer sk-1234567890abcdefghijklmnop\u001b[0m",
        ),
      );
    }
    const result = await install(
      undefined,
      invalid
        ? "https://%/frontend-design.tgz"
        : "https://user:pass@example.com/frontend-design.tgz",
    );
    if (invalid) {
      expect(result).toEqual({ ok: false, error: "failed to download ***: Invalid URL" });
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    } else {
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error).toContain(
        "failed to download https://***:***@example.com/frontend-design.tgz:",
      );
      expect(result.error).toContain("Authorization: Bearer sk-123…");
      expect(result.error).not.toContain("abcdefghijklmnop");
      expect(result.error).not.toContain("user:pass@");
      expect(Array.from(result.error).some((char) => char < " " || char === "\u007f")).toBe(false);
    }
    expect(installPluginFromPathMock).not.toHaveBeenCalled();
  });
});
