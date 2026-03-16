import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import { loadEnabledBundleMcpConfig } from "./bundle-mcp.js";
import { clearPluginManifestRegistryCache } from "./manifest-registry.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function canonicalExistingPath(filePath: string): string {
  return fsSync.realpathSync.native(filePath);
}

afterEach(async () => {
  clearPluginManifestRegistryCache();
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("loadEnabledBundleMcpConfig", () => {
  it("loads enabled Claude bundle MCP config and absolutizes relative args", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    try {
      const homeDir = await createTempDir("openclaw-bundle-mcp-home-");
      const workspaceDir = await createTempDir("openclaw-bundle-mcp-workspace-");
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_STATE_DIR;

      const pluginRoot = path.join(homeDir, ".openclaw", "extensions", "bundle-probe");
      const serverPath = path.join(pluginRoot, "servers", "probe.mjs");
      await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
      await fs.mkdir(path.dirname(serverPath), { recursive: true });
      await fs.writeFile(serverPath, "export {};\n", "utf-8");
      await fs.writeFile(
        path.join(pluginRoot, ".claude-plugin", "plugin.json"),
        `${JSON.stringify({ name: "bundle-probe" }, null, 2)}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              bundleProbe: {
                command: "node",
                args: ["./servers/probe.mjs"],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const config: OpenClawConfig = {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      };

      const loaded = loadEnabledBundleMcpConfig({
        workspaceDir,
        cfg: config,
      });
      const args = loaded.config.mcpServers.bundleProbe?.args;

      expect(loaded.diagnostics).toEqual([]);
      expect(loaded.config.mcpServers.bundleProbe?.command).toBe("node");
      expect(args).toHaveLength(1);
      expect(canonicalExistingPath(String(args?.[0]))).toBe(canonicalExistingPath(serverPath));
    } finally {
      env.restore();
    }
  });

  it("merges inline bundle MCP servers and skips disabled bundles", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    try {
      const homeDir = await createTempDir("openclaw-bundle-inline-home-");
      const workspaceDir = await createTempDir("openclaw-bundle-inline-workspace-");
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_STATE_DIR;

      const enabledRoot = path.join(homeDir, ".openclaw", "extensions", "inline-enabled");
      const disabledRoot = path.join(homeDir, ".openclaw", "extensions", "inline-disabled");
      await fs.mkdir(path.join(enabledRoot, ".claude-plugin"), { recursive: true });
      await fs.mkdir(path.join(disabledRoot, ".claude-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(enabledRoot, ".claude-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "inline-enabled",
            mcpServers: {
              enabledProbe: {
                command: "node",
                args: ["./enabled.mjs"],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(disabledRoot, ".claude-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "inline-disabled",
            mcpServers: {
              disabledProbe: {
                command: "node",
                args: ["./disabled.mjs"],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const config: OpenClawConfig = {
        plugins: {
          entries: {
            "inline-enabled": { enabled: true },
            "inline-disabled": { enabled: false },
          },
        },
      };

      const loaded = loadEnabledBundleMcpConfig({
        workspaceDir,
        cfg: config,
      });

      expect(loaded.config.mcpServers.enabledProbe).toBeDefined();
      expect(loaded.config.mcpServers.disabledProbe).toBeUndefined();
    } finally {
      env.restore();
    }
  });
});
