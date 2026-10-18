import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { PluginCandidate } from "../plugins/discovery.js";
import { resolvePluginNpmProjectDir } from "../plugins/install-paths.js";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index.js";

function writeJson(dir: string, name: string, value: unknown) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value), "utf8");
}

export async function readRequiredPersistedInstalledPluginIndex(
  stateDir: string,
): Promise<InstalledPluginIndex> {
  const persisted = await readPersistedInstalledPluginIndex({ stateDir });
  if (!persisted) {
    throw new Error("Expected persisted installed plugin index");
  }
  return persisted;
}

export function hermeticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
    ...overrides,
  };
}

export function createCandidate(rootDir: string, id = "demo"): PluginCandidate {
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load during doctor registry repair');\n",
    "utf8",
  );
  writeJson(rootDir, "openclaw.plugin.json", {
    id,
    name: id,
    configSchema: { type: "object" },
    providers: [id],
  });
  return {
    idHint: id,
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin: "global",
  };
}

export function createBundledCandidate(params: {
  rootDir: string;
  id: string;
  packageName: string;
  version: string;
  bundledDist?: boolean;
}): PluginCandidate {
  const packageManifest =
    params.bundledDist === undefined ? undefined : { build: { bundledDist: params.bundledDist } };
  const candidate = createCandidate(params.rootDir, params.id);
  writeJson(params.rootDir, "package.json", {
    name: params.packageName,
    version: params.version,
    ...(packageManifest ? { openclaw: packageManifest } : {}),
  });
  return {
    ...candidate,
    origin: "bundled",
    packageName: params.packageName,
    packageVersion: params.version,
    ...(packageManifest ? { packageManifest } : {}),
  };
}

export function createManagedNpmPlugin(params: {
  stateDir: string;
  id: string;
  packageName: string;
  version: string;
  peerDependencies?: Record<string, string>;
  packageLock?: boolean;
}) {
  const npmBaseDir = path.join(params.stateDir, "npm");
  const npmRoot = resolvePluginNpmProjectDir({
    npmDir: npmBaseDir,
    packageName: params.packageName,
  });
  const packageDir = path.join(npmRoot, "node_modules", ...params.packageName.split("/"));
  fs.mkdirSync(packageDir, { recursive: true });
  writeJson(npmRoot, "package.json", { dependencies: { [params.packageName]: params.version } });
  if (params.packageLock) {
    writeJson(npmRoot, "package-lock.json", {
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: {
            [params.packageName]: params.version,
            "other-plugin": "1.0.0",
          },
        },
        [`node_modules/${params.packageName}`]: { version: params.version },
        "node_modules/other-plugin": { version: "1.0.0" },
      },
      dependencies: {
        [params.packageName]: { version: params.version },
        "other-plugin": { version: "1.0.0" },
      },
    });
  }
  writeJson(packageDir, "package.json", {
    name: params.packageName,
    version: params.version,
    ...(params.peerDependencies ? { peerDependencies: params.peerDependencies } : {}),
    openclaw: { extensions: ["."] },
  });
  writeJson(packageDir, "openclaw.plugin.json", {
    id: params.id,
    name: params.id,
    configSchema: { type: "object" },
  });
  return { npmRoot, packageDir };
}

export function createCurrentIndex(): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  };
}

export function createCurrentIndexWithNpmRecord(params: {
  pluginId: string;
  packageName: string;
  packageDir: string;
  version: string;
}): InstalledPluginIndex {
  return {
    ...createCurrentIndex(),
    installRecords: {
      [params.pluginId]: {
        source: "npm",
        spec: `${params.packageName}@${params.version}`,
        installPath: params.packageDir,
        version: params.version,
        resolvedName: params.packageName,
        resolvedVersion: params.version,
        resolvedSpec: `${params.packageName}@${params.version}`,
      },
    },
  };
}

export function createCurrentIndexWithPathRecord(params: {
  pluginId: string;
  installPath: string;
  version?: string;
}): InstalledPluginIndex {
  return {
    ...createCurrentIndex(),
    installRecords: {
      [params.pluginId]: {
        source: "path",
        installPath: params.installPath,
        ...(params.version ? { version: params.version } : {}),
      },
    },
  };
}

export function expectedPluginIndexRecord(params: {
  rootDir: string;
  pluginId: string;
  origin: "bundled" | "global";
  packageName?: string;
  packageVersion?: string;
}) {
  return {
    pluginId: params.pluginId,
    ...(params.packageName ? { packageName: params.packageName } : {}),
    ...(params.packageVersion ? { packageVersion: params.packageVersion } : {}),
    manifestPath: path.join(params.rootDir, "openclaw.plugin.json"),
    manifestHash: expect.any(String),
    manifestFile: {
      size: expect.any(Number),
      mtimeMs: expect.any(Number),
      ctimeMs: expect.any(Number),
    },
    source: path.join(params.rootDir, "index.ts"),
    rootDir: params.rootDir,
    origin: params.origin,
    enabled: true,
    startup: {
      sidecar: false,
      memory: false,
      configPaths: [],
      agentHarnesses: [],
    },
    contributions: {
      channels: [],
      channelConfigs: [],
      providers: [params.pluginId],
      modelCatalogProviders: [],
      modelSupportPrefixes: [],
      modelSupportPatterns: [],
      autoEnableProviderIds: [],
      commandAliases: [],
      contracts: {},
    },
    compat: [],
  };
}
