// Detects plugin version drift between config, manifests, and installs.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import {
  resolveTrustedSourceLinkedOfficialClawHubInstall,
  resolveTrustedSourceLinkedOfficialNpmSpec,
} from "./official-external-install-records.js";

export type PluginVersionDriftEntry = {
  pluginId: string;
  installedVersion: string;
  gatewayVersion: string;
  source: PluginInstallRecord["source"];
  packageName?: string;
  spec?: string;
};

export type PluginRuntimeDependencyExpectation = {
  pluginId: string;
  dependencyName: string;
  expectedVersion: string;
};

export type PluginRuntimeDependencyDriftEntry = {
  pluginId: string;
  dependencyName: string;
  expectedVersion: string;
  source: PluginInstallRecord["source"];
  installedVersion?: string;
  installedDependencyVersion?: string;
  packageName?: string;
  spec?: string;
  installPath?: string;
};

export type PluginVersionDriftReport = {
  gatewayVersion: string;
  drifts: PluginVersionDriftEntry[];
  runtimeDependencyDrifts: PluginRuntimeDependencyDriftEntry[];
};

export const DEFAULT_PLUGIN_RUNTIME_DEPENDENCY_EXPECTATIONS: readonly PluginRuntimeDependencyExpectation[] =
  [
    {
      pluginId: "codex",
      dependencyName: "@openai/codex",
      expectedVersion: "0.142.5",
    },
  ];

function resolveExactNpmPinPackageName(entry: {
  source: PluginInstallRecord["source"];
  spec?: string;
}): string | undefined {
  if (entry.source !== "npm" || !entry.spec) {
    return undefined;
  }
  const parsed = parseRegistryNpmSpec(entry.spec);
  if (parsed?.selectorKind !== "exact-version") {
    return undefined;
  }
  return parsed.name;
}

/** Exact npm pins need a package@version target; id-only updates preserve the old pin. */
export function resolvePluginVersionDriftUpdateCommand(entry: PluginVersionDriftEntry): string {
  const exactNpmPackageName = resolveExactNpmPinPackageName(entry);
  if (exactNpmPackageName) {
    const exactNpmTarget = `${exactNpmPackageName}@${entry.gatewayVersion}`;
    if (parseRegistryNpmSpec(exactNpmTarget)?.selectorKind === "exact-version") {
      return `openclaw plugins update ${exactNpmTarget}`;
    }
  }
  return `openclaw plugins update ${entry.pluginId}`;
}

export function resolvePluginRuntimeDependencyDriftUpdateCommand(
  entry: PluginRuntimeDependencyDriftEntry,
): string {
  const exactNpmPackageName = resolveExactNpmPinPackageName(entry);
  if (exactNpmPackageName) {
    return `openclaw plugins update ${exactNpmPackageName}`;
  }
  return `openclaw plugins update ${entry.pluginId}`;
}

/**
 * Strip a trailing build qualifier (e.g. `2026.5.4-1` -> `2026.5.4`) so that
 * a gateway packaged as `2026.5.4-1` is not reported as drifted from a
 * plugin packaged as `2026.5.4`. Both ends are normalized identically.
 */
function normalizeVersion(value: string): string {
  return value.replace(/-\d+$/, "");
}

function isPluginEnabled(config: OpenClawConfig | undefined, pluginId: string): boolean {
  const normalizedPluginConfig = normalizePluginsConfig(config?.plugins);
  return resolveEffectiveEnableState({
    id: pluginId,
    origin: "global",
    config: normalizedPluginConfig,
    rootConfig: config,
  }).enabled;
}

function shouldCompareOfficialInstallToGateway(params: {
  pluginId: string;
  record: PluginInstallRecord;
}): boolean {
  const officialNpmSpec = resolveTrustedSourceLinkedOfficialNpmSpec(params);
  if (officialNpmSpec) {
    return parseRegistryNpmSpec(officialNpmSpec)?.selectorKind !== "exact-version";
  }
  const officialClawHubInstall = resolveTrustedSourceLinkedOfficialClawHubInstall(params);
  if (officialClawHubInstall) {
    if (officialClawHubInstall.clawhubSpec) {
      return !parseClawHubPluginSpec(officialClawHubInstall.clawhubSpec)?.version;
    }
    return (
      parseRegistryNpmSpec(officialClawHubInstall.npmSpec ?? "")?.selectorKind !== "exact-version"
    );
  }
  return false;
}

function isTrustedSourceLinkedOfficialInstall(params: {
  pluginId: string;
  record: PluginInstallRecord;
}): boolean {
  return Boolean(
    resolveTrustedSourceLinkedOfficialNpmSpec(params) ||
    resolveTrustedSourceLinkedOfficialClawHubInstall(params),
  );
}

function readPackageJsonDependencies(packageDir: string): {
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
} | null {
  const packageJsonPath = join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      dependencies?: unknown;
      optionalDependencies?: unknown;
    };
    const dependencies =
      parsed.dependencies &&
      typeof parsed.dependencies === "object" &&
      !Array.isArray(parsed.dependencies)
        ? (parsed.dependencies as Record<string, string>)
        : {};
    const optionalDependencies =
      parsed.optionalDependencies &&
      typeof parsed.optionalDependencies === "object" &&
      !Array.isArray(parsed.optionalDependencies)
        ? (parsed.optionalDependencies as Record<string, string>)
        : {};
    return { dependencies, optionalDependencies };
  } catch {
    return null;
  }
}

function buildRuntimeDependencyExpectationMap(
  expectations: readonly PluginRuntimeDependencyExpectation[],
): Map<string, PluginRuntimeDependencyExpectation[]> {
  const byPluginId = new Map<string, PluginRuntimeDependencyExpectation[]>();
  for (const expectation of expectations) {
    const current = byPluginId.get(expectation.pluginId) ?? [];
    current.push(expectation);
    byPluginId.set(expectation.pluginId, current);
  }
  return byPluginId;
}

function collectRuntimeDependencyDrifts(params: {
  installRecords: Record<string, PluginInstallRecord>;
  config?: OpenClawConfig;
  expectations: readonly PluginRuntimeDependencyExpectation[];
}): PluginRuntimeDependencyDriftEntry[] {
  const expectationsByPluginId = buildRuntimeDependencyExpectationMap(params.expectations);
  const drifts: PluginRuntimeDependencyDriftEntry[] = [];

  for (const [pluginId, record] of Object.entries(params.installRecords)) {
    if (!record || !isPluginEnabled(params.config, pluginId)) {
      continue;
    }
    const expectations = expectationsByPluginId.get(pluginId);
    if (!expectations?.length) {
      continue;
    }
    if (!isTrustedSourceLinkedOfficialInstall({ pluginId, record })) {
      continue;
    }
    if (!record.installPath) {
      continue;
    }
    const packageDependencies = readPackageJsonDependencies(record.installPath);
    if (!packageDependencies) {
      continue;
    }
    const installedVersion = record.resolvedVersion ?? record.version;
    for (const expectation of expectations) {
      const installedDependencyVersion =
        packageDependencies.dependencies[expectation.dependencyName] ??
        packageDependencies.optionalDependencies[expectation.dependencyName];
      if (installedDependencyVersion === expectation.expectedVersion) {
        continue;
      }
      drifts.push({
        pluginId,
        dependencyName: expectation.dependencyName,
        expectedVersion: expectation.expectedVersion,
        source: record.source,
        ...(installedVersion ? { installedVersion } : {}),
        ...(installedDependencyVersion ? { installedDependencyVersion } : {}),
        ...(record.resolvedName ? { packageName: record.resolvedName } : {}),
        ...(record.spec ? { spec: record.spec } : {}),
        installPath: record.installPath,
      });
    }
  }

  drifts.sort((a, b) => {
    const byPlugin = a.pluginId.localeCompare(b.pluginId);
    return byPlugin === 0 ? a.dependencyName.localeCompare(b.dependencyName) : byPlugin;
  });

  return drifts;
}

/**
 * Compare active official external plugin installs against the running gateway
 * version and return any mismatches.
 *
 * @param params.gatewayVersion The gateway version string (typically the
 *   `version` field of the installed openclaw package.json).
 * @param params.installRecords The full set of recorded plugin installs (as
 *   produced by `loadInstalledPluginIndexInstallRecords`).
 * @param params.config The merged daemon-side OpenClawConfig (optional).
 *   Plugins inactive under the effective activation policy are skipped.
 * @param params.runtimeDependencyExpectations Optional package-level runtime
 *   dependency contracts for official plugins. These catch cases where the
 *   plugin package version matches OpenClaw, but the route binary embedded
 *   inside that plugin is older than the release expects.
 *
 * The returned drift lists are sorted for stable output.
 */
export function detectPluginVersionDrift(params: {
  gatewayVersion: string;
  installRecords: Record<string, PluginInstallRecord>;
  config?: OpenClawConfig;
  runtimeDependencyExpectations?: readonly PluginRuntimeDependencyExpectation[];
}): PluginVersionDriftReport {
  const { gatewayVersion, installRecords, config } = params;
  const normalizedGateway = normalizeVersion(gatewayVersion);
  const drifts: PluginVersionDriftEntry[] = [];

  for (const [pluginId, record] of Object.entries(installRecords)) {
    if (!record) {
      continue;
    }
    if (!isPluginEnabled(config, pluginId)) {
      continue;
    }
    if (
      !shouldCompareOfficialInstallToGateway({
        pluginId,
        record,
      })
    ) {
      continue;
    }
    const installedVersion = record.resolvedVersion ?? record.version;
    if (!installedVersion) {
      // No version recorded for this install — nothing to compare against.
      // Don't fabricate drift; surface tooling (status.print) can flag this
      // separately if desired.
      continue;
    }
    if (normalizeVersion(installedVersion) === normalizedGateway) {
      continue;
    }
    drifts.push({
      pluginId,
      installedVersion,
      gatewayVersion,
      source: record.source,
      ...(record.resolvedName ? { packageName: record.resolvedName } : {}),
      ...(record.spec ? { spec: record.spec } : {}),
    });
  }

  drifts.sort((a, b) => a.pluginId.localeCompare(b.pluginId));

  return {
    gatewayVersion,
    drifts,
    runtimeDependencyDrifts: collectRuntimeDependencyDrifts({
      installRecords,
      config,
      expectations:
        params.runtimeDependencyExpectations ?? DEFAULT_PLUGIN_RUNTIME_DEPENDENCY_EXPECTATIONS,
    }),
  };
}
