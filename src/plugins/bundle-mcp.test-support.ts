import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearPluginManifestRegistryCache } from "./manifest-registry.js";

export function createBundleMcpTempHarness() {
  const tempDirs: string[] = [];

  return {
    async createTempDir(prefix: string): Promise<string> {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    },
    async cleanup() {
      clearPluginManifestRegistryCache();
      await Promise.all(
        tempDirs
          .splice(0, tempDirs.length)
          .map((dir) => fs.rm(dir, { recursive: true, force: true })),
      );
    },
  };
}

export async function createBundleProbePlugin(homeDir: string) {
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
  return { pluginRoot, serverPath };
}
