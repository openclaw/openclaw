import fs from "node:fs/promises";
import path from "node:path";
import { withEnvAsync } from "../test-utils/env.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

export function createBundleMcpTempHarness() {
  const dirs = createTrackedTempDirs();
  return { createTempDir: (prefix: string) => dirs.make(prefix), cleanup: () => dirs.cleanup() };
}

export function resolveBundlePluginRoot(homeDir: string, pluginId: string) {
  return path.join(homeDir, ".openclaw", "extensions", pluginId);
}

export async function writeBundleTextFiles(
  pluginRoot: string,
  files: Record<string, string>,
): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const filePath = path.join(pluginRoot, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf-8");
    }),
  );
}

export async function writeClaudeBundleManifest(params: {
  homeDir: string;
  pluginId: string;
  manifest: Record<string, unknown>;
}) {
  const pluginRoot = resolveBundlePluginRoot(params.homeDir, params.pluginId);
  await writeBundleTextFiles(pluginRoot, {
    ".claude-plugin/plugin.json": `${JSON.stringify(params.manifest, null, 2)}\n`,
  });
  return pluginRoot;
}

export function createEnabledPluginEntries(pluginIds: readonly string[]) {
  return Object.fromEntries(pluginIds.map((pluginId) => [pluginId, { enabled: true }]));
}

export async function createBundleProbePlugin(homeDir: string) {
  const pluginRoot = await writeClaudeBundleManifest({
    homeDir,
    pluginId: "bundle-probe",
    manifest: { name: "bundle-probe" },
  });
  const config = {
    mcpServers: { bundleProbe: { command: "node", args: ["./servers/probe.mjs"] } },
  };
  await writeBundleTextFiles(pluginRoot, {
    "servers/probe.mjs": "export {};\n",
    ".mcp.json": `${JSON.stringify(config, null, 2)}\n`,
  });
  return { pluginRoot, serverPath: path.join(pluginRoot, "servers", "probe.mjs") };
}

export async function withBundleHomeEnv<T>(
  tempHarness: { createTempDir: (prefix: string) => Promise<string> },
  prefix: string,
  run: (params: { homeDir: string; workspaceDir: string }) => Promise<T>,
): Promise<T> {
  const homeDir = await tempHarness.createTempDir(`${prefix}-home-`);
  const workspaceDir = await tempHarness.createTempDir(`${prefix}-workspace-`);

  return withEnvAsync(
    {
      HOME: homeDir,
      USERPROFILE: homeDir,
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: undefined,
    },
    () => run({ homeDir, workspaceDir }),
  );
}
