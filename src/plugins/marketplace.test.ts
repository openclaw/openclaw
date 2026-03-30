import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";

const installPluginFromPathMock = vi.fn();
const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn(async (params: { url: string; init?: RequestInit }) => {
    // Keep unit tests focused on guarded call sites, not AbortSignal timer behavior.
    const { signal: _signal, ...init } = params.init ?? {};
    const response = await fetch(params.url, init);
    return {
      response,
      finalUrl: params.url,
      release: async () => {
        await response.body?.cancel().catch(() => undefined);
      },
    };
  }),
);
const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

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

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-marketplace-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeMarketplaceManifest(rootDir: string, manifest: unknown): Promise<string> {
  const manifestPath = path.join(rootDir, ".claude-plugin", "marketplace.json");
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return manifestPath;
}

async function writeRemoteMarketplaceFixture(params: {
  repoDir: string;
  manifest: unknown;
  pluginDir?: string;
}) {
  await fs.mkdir(path.join(params.repoDir, ".claude-plugin"), { recursive: true });
  if (params.pluginDir) {
    await fs.mkdir(path.join(params.repoDir, params.pluginDir), { recursive: true });
  }
  await fs.writeFile(
    path.join(params.repoDir, ".claude-plugin", "marketplace.json"),
    JSON.stringify(params.manifest),
  );
}

async function writeLocalMarketplaceFixture(params: {
  rootDir: string;
  manifest: unknown;
  pluginDir?: string;
}) {
  if (params.pluginDir) {
    await fs.mkdir(params.pluginDir, { recursive: true });
  }
  return writeMarketplaceManifest(params.rootDir, params.manifest);
}

function mockRemoteMarketplaceClone(params: { manifest: unknown; pluginDir?: string }) {
  runCommandWithTimeoutMock.mockImplementationOnce(async (argv: string[]) => {
    const repoDir = argv.at(-1);
    expect(typeof repoDir).toBe("string");
    await writeRemoteMarketplaceFixture({
      repoDir: repoDir as string,
      manifest: params.manifest,
      ...(params.pluginDir ? { pluginDir: params.pluginDir } : {}),
    });
    return { code: 0, stdout: "", stderr: "", killed: false };
  });
}

async function expectRemoteMarketplaceError(params: { manifest: unknown; expectedError: string }) {
  mockRemoteMarketplaceClone({ manifest: params.manifest });

  const { listMarketplacePlugins } = await import("./marketplace.js");
  const result = await listMarketplacePlugins({ marketplace: "owner/repo" });

  expect(result).toEqual({
    ok: false,
    error: params.expectedError,
  });
  expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
}

function expectRemoteMarketplaceInstallResult(result: unknown) {
  expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
  expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
    ["git", "clone", "--depth", "1", "https://github.com/owner/repo.git", expect.any(String)],
    { timeoutMs: 120_000 },
  );
  expect(installPluginFromPathMock).toHaveBeenCalledWith(
    expect.objectContaining({
      path: expect.stringMatching(/[\\/]repo[\\/]plugins[\\/]frontend-design$/),
    }),
  );
  expect(result).toMatchObject({
    ok: true,
    pluginId: "frontend-design",
    marketplacePlugin: "frontend-design",
    marketplaceSource: "owner/repo",
  });
}

function expectMarketplaceManifestListing(
  result: Awaited<ReturnType<typeof import("./marketplace.js").listMarketplacePlugins>>,
) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected marketplace listing to succeed");
  }
  expect(result.sourceLabel.replaceAll("\\", "/")).toContain(".claude-plugin/marketplace.json");
  expect(result.manifest).toEqual({
    name: "Example Marketplace",
    version: "1.0.0",
    plugins: [
      {
        name: "frontend-design",
        version: "0.1.0",
        description: "Design system bundle",
        source: { kind: "path", path: "./plugins/frontend-design" },
      },
    ],
  });
}

function expectLocalMarketplaceInstallResult(params: {
  result: unknown;
  pluginDir: string;
  marketplaceSource: string;
}) {
  expect(installPluginFromPathMock).toHaveBeenCalledWith(
    expect.objectContaining({
      path: params.pluginDir,
    }),
  );
  expect(params.result).toMatchObject({
    ok: true,
    pluginId: "frontend-design",
    marketplacePlugin: "frontend-design",
    marketplaceSource: params.marketplaceSource,
  });
}

describe("marketplace plugins", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockClear();
    installPluginFromPathMock.mockReset();
    runCommandWithTimeoutMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("lists plugins from a local marketplace root", async () => {
    await withTempDir(async (rootDir) => {
      await writeMarketplaceManifest(rootDir, {
        name: "Example Marketplace",
        version: "1.0.0",
        plugins: [
          {
            name: "frontend-design",
            version: "0.1.0",
            description: "Design system bundle",
            source: "./plugins/frontend-design",
          },
        ],
      });

      const { listMarketplacePlugins } = await import("./marketplace.js");
      expectMarketplaceManifestListing(await listMarketplacePlugins({ marketplace: rootDir }));
    });
  });

  it("resolves relative plugin paths against the marketplace root", async () => {
    await withTempDir(async (rootDir) => {
      const pluginDir = path.join(rootDir, "plugins", "frontend-design");
      const manifestPath = await writeLocalMarketplaceFixture({
        rootDir,
        pluginDir,
        manifest: {
          plugins: [
            {
              name: "frontend-design",
              source: "./plugins/frontend-design",
            },
          ],
        },
      });
      installPluginFromPathMock.mockResolvedValue({
        ok: true,
        pluginId: "frontend-design",
        targetDir: "/tmp/frontend-design",
        version: "0.1.0",
        extensions: ["index.ts"],
      });

      const { installPluginFromMarketplace } = await import("./marketplace.js");
      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expectLocalMarketplaceInstallResult({
        result,
        pluginDir,
        marketplaceSource: path.join(rootDir, ".claude-plugin", "marketplace.json"),
      });
    });
  });

  it("resolves Claude-style plugin@marketplace shortcuts from known_marketplaces.json", async () => {
    await withTempDir(async (homeDir) => {
      const openClawHome = path.join(homeDir, "openclaw-home");
      await fs.mkdir(path.join(homeDir, ".claude", "plugins"), { recursive: true });
      await fs.mkdir(openClawHome, { recursive: true });
      await fs.writeFile(
        path.join(homeDir, ".claude", "plugins", "known_marketplaces.json"),
        JSON.stringify({
          "claude-plugins-official": {
            source: {
              source: "github",
              repo: "anthropics/claude-plugins-official",
            },
            installLocation: path.join(homeDir, ".claude", "plugins", "marketplaces", "official"),
          },
        }),
      );

      const { resolveMarketplaceInstallShortcut } = await import("./marketplace.js");
      const shortcut = await withEnvAsync(
        { HOME: homeDir, OPENCLAW_HOME: openClawHome },
        async () => await resolveMarketplaceInstallShortcut("superpowers@claude-plugins-official"),
      );

      expect(shortcut).toEqual({
        ok: true,
        plugin: "superpowers",
        marketplaceName: "claude-plugins-official",
        marketplaceSource: "claude-plugins-official",
      });
    });
  });

  it("installs remote marketplace plugins from relative paths inside the cloned repo", async () => {
    mockRemoteMarketplaceClone({
      pluginDir: path.join("plugins", "frontend-design"),
      manifest: {
        plugins: [
          {
            name: "frontend-design",
            source: "./plugins/frontend-design",
          },
        ],
      },
    });
    installPluginFromPathMock.mockResolvedValue({
      ok: true,
      pluginId: "frontend-design",
      targetDir: "/tmp/frontend-design",
      version: "0.1.0",
      extensions: ["index.ts"],
    });

    const { installPluginFromMarketplace } = await import("./marketplace.js");
    const result = await installPluginFromMarketplace({
      marketplace: "owner/repo",
      plugin: "frontend-design",
    });

    expectRemoteMarketplaceInstallResult(result);
  });

  it("returns a structured error for archive downloads with an empty response body", async () => {
    await withTempDir(async (rootDir) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 200 })),
      );
      const manifestPath = await writeMarketplaceManifest(rootDir, {
        plugins: [
          {
            name: "frontend-design",
            source: "https://example.com/frontend-design.tgz",
          },
        ],
      });

      const { installPluginFromMarketplace } = await import("./marketplace.js");
      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error: "failed to download https://example.com/frontend-design.tgz: empty response body",
      });
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: "https://example.com/frontend-design.tgz",
        auditContext: "marketplace-plugin-download",
      });
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      name: "rejects remote marketplace git plugin sources before cloning nested remotes",
      manifest: {
        plugins: [
          {
            name: "frontend-design",
            source: {
              type: "git",
              url: "https://evil.example/repo.git",
            },
          },
        ],
      },
      expectedError:
        'invalid marketplace entry "frontend-design" in owner/repo: ' +
        "remote marketplaces may not use git plugin sources",
    },
    {
      name: "rejects remote marketplace absolute plugin paths",
      manifest: {
        plugins: [
          {
            name: "frontend-design",
            source: {
              type: "path",
              path: "/tmp/frontend-design",
            },
          },
        ],
      },
      expectedError:
        'invalid marketplace entry "frontend-design" in owner/repo: ' +
        "remote marketplaces may only use relative plugin paths",
    },
    {
      name: "rejects remote marketplace HTTP plugin paths",
      manifest: {
        plugins: [
          {
            name: "frontend-design",
            source: {
              type: "path",
              path: "https://evil.example/plugin.tgz",
            },
          },
        ],
      },
      expectedError:
        'invalid marketplace entry "frontend-design" in owner/repo: ' +
        "remote marketplaces may not use HTTP(S) plugin paths",
    },
  ] as const)("$name", async ({ manifest, expectedError }) => {
    await expectRemoteMarketplaceError({ manifest, expectedError });
  });
});
