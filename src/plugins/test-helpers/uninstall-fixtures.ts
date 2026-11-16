/** Install-record and filesystem layouts shared by plugin uninstall cases. */
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolvePluginInstallDir } from "../install.js";

type PluginConfig = NonNullable<OpenClawConfig["plugins"]>;
type PluginInstallRecord = NonNullable<PluginConfig["installs"]>[string];

export async function createInstalledNpmPluginFixture(params: {
  baseDir: string;
  pluginId?: string;
}): Promise<{
  pluginId: string;
  extensionsDir: string;
  pluginDir: string;
  config: OpenClawConfig;
}> {
  const pluginId = params.pluginId ?? "my-plugin";
  const extensionsDir = path.join(params.baseDir, "extensions");
  const pluginDir = resolvePluginInstallDir(pluginId, extensionsDir);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "index.js"), "// plugin");

  return {
    pluginId,
    extensionsDir,
    pluginDir,
    config: {
      plugins: {
        entries: {
          [pluginId]: { enabled: true },
        },
        installs: {
          [pluginId]: {
            source: "npm",
            spec: `${pluginId}@1.0.0`,
            installPath: pluginDir,
          },
        },
      },
    },
  };
}

export function createSinglePluginEntries(pluginId = "my-plugin") {
  return {
    [pluginId]: { enabled: true },
  };
}

export function createNpmInstallRecord(
  pluginId = "my-plugin",
  installPath?: string,
): PluginInstallRecord {
  return {
    source: "npm",
    spec: `${pluginId}@1.0.0`,
    ...(installPath ? { installPath } : {}),
  };
}

export function createGitInstallRecord(
  pluginId = "my-plugin",
  installPath?: string,
): PluginInstallRecord {
  return {
    source: "git",
    spec: `git:https://github.com/acme/${pluginId}.git`,
    gitUrl: `https://github.com/acme/${pluginId}.git`,
    gitCommit: "abc123",
    ...(installPath ? { installPath } : {}),
  };
}

export function createMarketplaceInstallRecord(installPath: string): PluginInstallRecord {
  return {
    source: "marketplace",
    installPath,
    marketplaceSource: "release-fixtures",
    marketplacePlugin: "my-plugin",
  };
}

export function createPathInstallRecord(
  installPath = "/path/to/plugin",
  sourcePath = installPath,
): PluginInstallRecord {
  return {
    source: "path",
    sourcePath,
    installPath,
  };
}

export function createPluginConfig(params: {
  entries?: Record<string, { enabled: boolean }>;
  installs?: Record<string, PluginInstallRecord>;
  allow?: string[];
  deny?: string[];
  enabled?: boolean;
  slots?: PluginConfig["slots"];
  loadPaths?: string[];
  channels?: OpenClawConfig["channels"];
}): OpenClawConfig {
  const plugins: PluginConfig = {};
  if (params.entries) {
    plugins.entries = params.entries;
  }
  if (params.installs) {
    plugins.installs = params.installs;
  }
  if (params.allow) {
    plugins.allow = params.allow;
  }
  if (params.deny) {
    plugins.deny = params.deny;
  }
  if (params.enabled !== undefined) {
    plugins.enabled = params.enabled;
  }
  if (params.slots) {
    plugins.slots = params.slots;
  }
  if (params.loadPaths) {
    plugins.load = { paths: params.loadPaths };
  }
  return {
    ...(Object.keys(plugins).length > 0 ? { plugins } : {}),
    ...(params.channels ? { channels: params.channels } : {}),
  };
}

export function createSinglePluginWithEmptySlotsConfig(): OpenClawConfig {
  return createPluginConfig({
    entries: createSinglePluginEntries(),
    slots: {},
  });
}

export function createSingleNpmInstallConfig(installPath: string): OpenClawConfig {
  return createPluginConfig({
    entries: createSinglePluginEntries(),
    installs: {
      "my-plugin": createNpmInstallRecord("my-plugin", installPath),
    },
  });
}

export function createKitchenSinkInstallConfig(
  installPath: string,
  entries?: Record<string, { enabled: boolean }>,
): OpenClawConfig {
  return createPluginConfig({
    entries,
    installs: {
      "openclaw-kitchen-sink-fixture": {
        source: "npm",
        spec: "@openclaw/kitchen-sink@1.0.0",
        installPath,
      },
    },
  });
}

export async function createPluginDirFixture(baseDir: string, pluginId = "my-plugin") {
  const pluginDir = path.join(baseDir, pluginId);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "index.js"), "// plugin");
  return pluginDir;
}

export async function writePackageJson(directory: string, manifest: Record<string, unknown>) {
  await fs.writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
