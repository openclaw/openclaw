import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";

const installPluginFromPathMock = vi.fn();

vi.mock("./install.js", () => ({
  installPluginFromPath: (...args: unknown[]) => installPluginFromPathMock(...args),
}));

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-marketplace-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("marketplace plugins", () => {
  afterEach(() => {
    installPluginFromPathMock.mockReset();
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
});
