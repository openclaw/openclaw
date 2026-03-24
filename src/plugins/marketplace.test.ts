import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";

const installPluginFromPathMock = vi.fn();
const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("./install.js", () => ({
  installPluginFromPath: (...args: unknown[]) => installPluginFromPathMock(...args),
}));

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

function mockRemoteMarketplaceClone(manifest: unknown) {
  runCommandWithTimeoutMock.mockImplementationOnce(async (argv: string[]) => {
    const repoDir = argv.at(-1);
    expect(typeof repoDir).toBe("string");
    await fs.mkdir(path.join(repoDir as string, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir as string, ".claude-plugin", "marketplace.json"),
      JSON.stringify(manifest),
    );
    return { code: 0, stdout: "", stderr: "", killed: false };
  });
}

describe("marketplace plugins", () => {
  afterEach(() => {
    installPluginFromPathMock.mockReset();
    runCommandWithTimeoutMock.mockReset();
  });

  it("lists plugins from a local marketplace root", async () => {
    await withTempDir(async (rootDir) => {
      await fs.mkdir(path.join(rootDir, ".claude-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(rootDir, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
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
        }),
      );

      const { listMarketplacePlugins } = await import("./marketplace.js");
      const result = await listMarketplacePlugins({ marketplace: rootDir });
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
    });
  });

  it("resolves relative plugin paths against the marketplace root", async () => {
    await withTempDir(async (rootDir) => {
      const pluginDir = path.join(rootDir, "plugins", "frontend-design");
      await fs.mkdir(path.join(rootDir, ".claude-plugin"), { recursive: true });
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(
        path.join(rootDir, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          plugins: [
            {
              name: "frontend-design",
              source: "./plugins/frontend-design",
            },
          ],
        }),
      );
      installPluginFromPathMock.mockResolvedValue({
        ok: true,
        pluginId: "frontend-design",
        targetDir: "/tmp/frontend-design",
        version: "0.1.0",
        extensions: ["index.ts"],
      });

      const { installPluginFromMarketplace } = await import("./marketplace.js");
      const result = await installPluginFromMarketplace({
        marketplace: path.join(rootDir, ".claude-plugin", "marketplace.json"),
        plugin: "frontend-design",
      });

      expect(installPluginFromPathMock).toHaveBeenCalledWith(
        expect.objectContaining({
          path: pluginDir,
        }),
      );
      expect(result).toMatchObject({
        ok: true,
        pluginId: "frontend-design",
        marketplacePlugin: "frontend-design",
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
    runCommandWithTimeoutMock.mockImplementationOnce(async (argv: string[]) => {
      const repoDir = argv.at(-1);
      expect(typeof repoDir).toBe("string");
      await fs.mkdir(path.join(repoDir as string, ".claude-plugin"), { recursive: true });
      await fs.mkdir(path.join(repoDir as string, "plugins", "frontend-design"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(repoDir as string, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          plugins: [
            {
              name: "frontend-design",
              source: "./plugins/frontend-design",
            },
          ],
        }),
      );
      return { code: 0, stdout: "", stderr: "", killed: false };
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
  });

  it("rejects remote marketplace git plugin sources before cloning nested remotes", async () => {
    mockRemoteMarketplaceClone({
      plugins: [
        {
          name: "frontend-design",
          source: {
            type: "git",
            url: "https://evil.example/repo.git",
          },
        },
      ],
    });

    const { listMarketplacePlugins } = await import("./marketplace.js");
    const result = await listMarketplacePlugins({ marketplace: "owner/repo" });

    expect(result).toEqual({
      ok: false,
      error:
        'invalid marketplace entry "frontend-design" in owner/repo: ' +
        "remote marketplaces may not use git plugin sources",
    });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("rejects remote marketplace absolute plugin paths", async () => {
    mockRemoteMarketplaceClone({
      plugins: [
        {
          name: "frontend-design",
          source: {
            type: "path",
            path: "/tmp/frontend-design",
          },
        },
      ],
    });

    const { listMarketplacePlugins } = await import("./marketplace.js");
    const result = await listMarketplacePlugins({ marketplace: "owner/repo" });

    expect(result).toEqual({
      ok: false,
      error:
        'invalid marketplace entry "frontend-design" in owner/repo: ' +
        "remote marketplaces may only use relative plugin paths",
    });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("rejects remote marketplace HTTP plugin paths", async () => {
    mockRemoteMarketplaceClone({
      plugins: [
        {
          name: "frontend-design",
          source: {
            type: "path",
            path: "https://evil.example/plugin.tgz",
          },
        },
      ],
    });

    const { listMarketplacePlugins } = await import("./marketplace.js");
    const result = await listMarketplacePlugins({ marketplace: "owner/repo" });

    expect(result).toEqual({
      ok: false,
      error:
        'invalid marketplace entry "frontend-design" in owner/repo: ' +
        "remote marketplaces may not use HTTP(S) plugin paths",
    });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
  });
});
