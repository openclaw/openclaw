import { managementMetadata } from "./management-service.test-support.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
const path = "/tmp/openclaw.json";

export function configSnapshot(config: Record<string, unknown> = {}) {
  return {
    snapshot: { valid: true, parsed: {}, path, sourceConfig: config, hash: "base-hash" },
    writeOptions: {
      expectedConfigPath: path,
      includeFileHashesForWrite: { "/tmp/plugins.json": "include-hash" },
      includeFileTargetsForWrite: { "/tmp/plugins.json": "/tmp/plugins.json" },
    },
  };
}

export function metadataSnapshot(params: {
  enabled: boolean;
  id?: string;
  name?: string;
  origin?: "bundled" | "global" | "config";
  installRecord?: Record<string, unknown>;
  packageBuild?: { bundledDist?: boolean };
  packageDependencies?: Record<string, string>;
  iconPath?: string;
  activityIconPath?: string;
  toolActivityIconPaths?: Record<string, string>;
  categories?: PluginManifestRecord["categories"];
  contracts?: PluginManifestRecord["contracts"];
  packageVersion?: string;
  configSchema?: PluginManifestRecord["configSchema"];
  channels?: string[];
}) {
  const id = params.id ?? "workboard";
  const origin = params.origin ?? "bundled";
  const installRecord =
    params.installRecord ??
    (origin === "global" ? { source: "path", installPath: `/tmp/${id}` } : undefined);
  const base = managementMetadata({ id, name: params.name, enabled: params.enabled });
  const manifest: PluginManifestRecord = {
    ...base.plugins[0]!,
    ...(params.categories ? { categories: params.categories } : {}),
    ...(params.contracts ? { contracts: params.contracts } : {}),
    ...(params.packageDependencies ? { packageDependencies: params.packageDependencies } : {}),
    ...(params.iconPath ? { iconPath: params.iconPath } : {}),
    ...(params.activityIconPath ? { activityIconPath: params.activityIconPath } : {}),
    ...(params.toolActivityIconPaths
      ? { toolActivityIconPaths: params.toolActivityIconPaths }
      : {}),
    channels: params.channels ?? [],
    origin,
    ...(params.configSchema ? { configSchema: params.configSchema } : {}),
  };
  const record = {
    ...base.index.plugins[0]!,
    packageName: `@openclaw/${id}`,
    ...(origin === "global" ? { installOwner: id } : {}),
    ...(params.packageVersion ? { packageVersion: params.packageVersion } : {}),
    origin,
    ...(params.packageBuild ? { packageBuild: params.packageBuild } : {}),
  };
  return {
    ...base,
    index: {
      plugins: [record],
      installRecords: installRecord ? { [id]: installRecord } : {},
    },
    byPluginId: new Map([[id, manifest]]),
    plugins: [manifest],
  };
}

export const emptyMetadataSnapshot = () => ({
  index: { plugins: [], installRecords: {} },
  byPluginId: new Map(),
  plugins: [],
  diagnostics: [],
  normalizePluginId: (pluginId: string) => pluginId,
});

export const hostedDiffsEntry = { openclaw: { plugin: { id: "diffs" } } };

export const hostedFeedDiffsEntry = {
  id: "@openclaw/diffs",
  title: "Diffs",
  state: "available",
  featured: true,
  publisher: { id: "openclaw", trust: "official" },
  install: {
    candidates: [
      {
        sourceRef: "public-clawhub",
        package: "@openclaw/diffs",
        version: "2026.6.11",
        integrity: `sha256:${"a".repeat(64)}`,
      },
    ],
  },
};
