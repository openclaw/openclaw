import path from "node:path";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../../../infra/clawhub-spec.js";
import { parseRegistryNpmSpec } from "../../../infra/npm-registry-spec.js";
import {
  resolveDefaultPluginExtensionsDir,
  resolveDefaultPluginNpmDir,
  resolvePluginInstallDir,
  resolvePluginNpmPackageDir,
} from "../../../plugins/install-paths.js";
import { resolveUserPath } from "../../../utils.js";

export function forceNpmInstallRecordRepair(record: PluginInstallRecord): PluginInstallRecord {
  if (record.source !== "npm") {
    return record;
  }
  const next = { ...record };
  delete next.resolvedSpec;
  delete next.resolvedVersion;
  return next;
}

export function installPathsEqual(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export function resolveLegacyNpmPackageInstallPath(params: {
  packageName: string;
  npmRoot: string;
}): string {
  return path.join(params.npmRoot, "node_modules", ...params.packageName.split("/"));
}

function collectCandidateOfficialPackageNames(candidate: {
  npmSpec?: string;
  clawhubSpec?: string;
}): Set<string> {
  return new Set(
    [
      candidate.npmSpec ? parseRegistryNpmSpec(candidate.npmSpec)?.name : undefined,
      candidate.clawhubSpec ? parseClawHubPluginSpec(candidate.clawhubSpec)?.name : undefined,
    ].filter((name): name is string => Boolean(name)),
  );
}

function collectInstalledRecordPackageNames(record: PluginInstallRecord): Set<string> {
  const names =
    record.source === "npm"
      ? [
          record.resolvedName,
          record.spec ? parseRegistryNpmSpec(record.spec)?.name : undefined,
          record.resolvedSpec ? parseRegistryNpmSpec(record.resolvedSpec)?.name : undefined,
        ]
      : record.source === "clawhub"
        ? [
            record.clawhubPackage,
            record.spec ? parseClawHubPluginSpec(record.spec)?.name : undefined,
          ]
        : [];
  return new Set(names.filter((name): name is string => Boolean(name)));
}

export function isTrustedOfficialInstallRecordForCandidate(params: {
  record: PluginInstallRecord | undefined;
  candidate: { npmSpec?: string; clawhubSpec?: string };
}): boolean {
  const record = params.record;
  if (!record) {
    return false;
  }
  if (record.source !== "npm" && record.source !== "clawhub") {
    return false;
  }
  if (record.source === "clawhub" && record.clawhubChannel !== "official") {
    return false;
  }
  const candidatePackageNames = collectCandidateOfficialPackageNames(params.candidate);
  return (
    candidatePackageNames.size > 0 &&
    [...collectInstalledRecordPackageNames(record)].some((name) => candidatePackageNames.has(name))
  );
}

export function resolveSafeBrokenOfficialInstallRemovalPath(params: {
  pluginId: string;
  candidate: { npmSpec?: string };
  record: PluginInstallRecord | undefined;
  env: NodeJS.ProcessEnv;
}): string | null {
  const installPath = params.record?.installPath?.trim();
  if (!installPath) {
    return null;
  }
  const resolvedInstallPath = resolveUserPath(installPath, params.env);
  try {
    const extensionsDir = resolveDefaultPluginExtensionsDir(params.env);
    const expectedExtensionPath = resolvePluginInstallDir(params.pluginId, extensionsDir);
    if (installPathsEqual(resolvedInstallPath, expectedExtensionPath)) {
      return resolvedInstallPath;
    }
  } catch {
    // Ignore malformed plugin ids here; the installer will surface the real failure.
  }
  const parsedNpmSpec = params.candidate.npmSpec
    ? parseRegistryNpmSpec(params.candidate.npmSpec)
    : null;
  if (!parsedNpmSpec?.name) {
    return null;
  }
  const npmRoot = resolveDefaultPluginNpmDir(params.env);
  const expectedNpmPaths = [
    resolvePluginNpmPackageDir({
      packageName: parsedNpmSpec.name,
      npmDir: npmRoot,
    }),
    resolveLegacyNpmPackageInstallPath({
      packageName: parsedNpmSpec.name,
      npmRoot,
    }),
  ];
  return expectedNpmPaths.some((expectedPath) =>
    installPathsEqual(resolvedInstallPath, expectedPath),
  )
    ? resolvedInstallPath
    : null;
}

export function recordMatchesBundledPackage(
  record: PluginInstallRecord,
  bundled: { packageName?: string },
): boolean {
  const packageName = bundled.packageName?.trim();
  return Boolean(packageName && collectInstalledRecordPackageNames(record).has(packageName));
}
