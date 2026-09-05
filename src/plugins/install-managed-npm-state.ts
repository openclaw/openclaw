import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { NpmSpecResolution } from "../infra/install-source-utils.js";
import { parseRegistryNpmSpec, validateRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { isNotFoundPathError } from "../infra/path-guards.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmGenerationProjectDirPrefix,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import { loadPluginInstallRuntime } from "./install-shared.js";
import { hasRetainedManagedNpmInstallMarker } from "./managed-npm-retention.js";
import type { OpenClawPackageManifest } from "./manifest.js";

const MANAGED_NPM_PROJECT_QUARANTINE_DIR = "_openclaw-quarantined-npm-projects";
const MANAGED_NPM_PROJECT_REBUILD_ARTIFACTS = [
  "node_modules",
  "package-lock.json",
  // Pre-migration projects may retain a root shrinkwrap that npm 11 prefers.
  "npm-shrinkwrap.json",
] as const;

export function isNpmAliasOverrideCompatibilityError(result: {
  stdout: string;
  stderr: string;
}): boolean {
  return `${result.stderr}\n${result.stdout}`.includes("Invalid comparator: npm:");
}

export type ManagedNpmRootPreparedDependency = {
  dependencySpec: string;
};

export type ManagedNpmProjectQuarantine = {
  quarantineDir: string;
  movedArtifactNames: string[];
};

type ManagedNpmRootPrepareDependencyResult =
  | ({ ok: true } & ManagedNpmRootPreparedDependency)
  | {
      ok: false;
      error: string;
    };

export type ManagedNpmRootDependencySpecPreparation = (params: {
  npmRoot: string;
}) => Promise<ManagedNpmRootPrepareDependencyResult>;

export async function resolveManagedNpmRootDependencySpecForInstall(params: {
  npmRoot: string;
  packageName: string;
  dependencySpec?: string;
  prepareDependencySpec?: ManagedNpmRootDependencySpecPreparation;
}): Promise<ManagedNpmRootPrepareDependencyResult> {
  if (params.prepareDependencySpec) {
    try {
      return await params.prepareDependencySpec({ npmRoot: params.npmRoot });
    } catch (error) {
      return {
        ok: false,
        error: `Failed to prepare managed npm dependency for ${params.packageName}: ${String(error)}`,
      };
    }
  }
  if (params.dependencySpec === undefined) {
    return {
      ok: false,
      error: `missing managed npm dependency spec for ${params.packageName}`,
    };
  }
  return { ok: true, dependencySpec: params.dependencySpec };
}

export async function shouldCopyManagedNpmProjectEntry(params: {
  nodeModulesDir: string;
  sourcePath: string;
}): Promise<boolean> {
  const relativeParts = path.relative(params.nodeModulesDir, params.sourcePath).split(path.sep);
  const isPluginLocalOpenClawPeer =
    (relativeParts.length === 3 &&
      relativeParts[1] === "node_modules" &&
      relativeParts[2] === "openclaw") ||
    (relativeParts.length === 4 &&
      relativeParts[0]?.startsWith("@") &&
      relativeParts[2] === "node_modules" &&
      relativeParts[3] === "openclaw");
  if (!isPluginLocalOpenClawPeer) {
    return true;
  }

  try {
    return !(await fs.lstat(params.sourcePath)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function isManagedNpmProjectCorruptionInstallFailure(result: {
  stdout: string;
  stderr: string;
}): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return (
    output.includes("ERR_INVALID_ARG_TYPE") &&
    output.includes('"from" argument') &&
    output.includes("Received undefined")
  );
}

export function formatManagedNpmProjectQuarantineArtifacts(artifactNames: string[]): string {
  return artifactNames.length > 0 ? artifactNames.join(", ") : "no rebuild artifacts";
}

export async function quarantineManagedNpmProjectRebuildArtifacts(params: {
  npmRoot: string;
  recoveryRoot: string;
}): Promise<ManagedNpmProjectQuarantine> {
  const quarantineParent = path.join(params.recoveryRoot, MANAGED_NPM_PROJECT_QUARANTINE_DIR);
  await fs.mkdir(quarantineParent, { recursive: true });
  const quarantineDir = await fs.mkdtemp(path.join(quarantineParent, "corrupt-"));
  const movedArtifactNames: string[] = [];
  try {
    for (const artifactName of MANAGED_NPM_PROJECT_REBUILD_ARTIFACTS) {
      const source = path.join(params.npmRoot, artifactName);
      try {
        await fs.rename(source, path.join(quarantineDir, artifactName));
        movedArtifactNames.push(artifactName);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
  } catch (error) {
    throw new Error(
      `Managed npm recovery artifacts are retained at ${quarantineDir}: ${String(error)}`,
      {
        cause: error,
      },
    );
  }
  return { quarantineDir, movedArtifactNames };
}

export async function listManagedNpmRootPackageNames(npmRoot: string): Promise<Set<string>> {
  const nodeModulesDir = path.join(npmRoot, "node_modules");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(nodeModulesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set();
    }
    throw error;
  }

  const packageNames = new Set<string>();
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".bin" || entry.name === "openclaw") {
      continue;
    }
    if (entry.name.startsWith("@")) {
      const scopeDir = path.join(nodeModulesDir, entry.name);
      let scopedEntries: Dirent[];
      try {
        scopedEntries = await fs.readdir(scopeDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      for (const scopedEntry of scopedEntries.toSorted((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        if (scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) {
          packageNames.add(`${entry.name}/${scopedEntry.name}`);
        }
      }
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      packageNames.add(entry.name);
    }
  }
  return packageNames;
}

export function resolveManagedNpmRootPackageDir(npmRoot: string, packageName: string): string {
  return path.join(npmRoot, "node_modules", ...packageName.split("/"));
}

function resolveManagedNpmRootGenerationKey(params: {
  packageName: string;
  npmResolution: NpmSpecResolution;
}): string {
  return [
    params.npmResolution.name ?? params.packageName,
    params.npmResolution.version ?? "",
    params.npmResolution.resolvedSpec ?? "",
    params.npmResolution.integrity ?? "",
    params.npmResolution.shasum ?? "",
  ].join("\n");
}

export function resolveManagedNpmRootForInstall(params: {
  npmBaseDir: string;
  packageName: string;
  npmResolution: NpmSpecResolution;
  useGeneration: boolean;
}): string {
  if (!params.useGeneration) {
    return resolvePluginNpmProjectDir({
      npmDir: params.npmBaseDir,
      packageName: params.packageName,
    });
  }
  return resolvePluginNpmGenerationProjectDir({
    npmDir: params.npmBaseDir,
    packageName: params.packageName,
    generationKey: resolveManagedNpmRootGenerationKey({
      packageName: params.packageName,
      npmResolution: params.npmResolution,
    }),
  });
}

export function resolveManagedNpmInstallRoot(params: {
  npmBaseDir: string;
  packageName: string;
  npmResolution: NpmSpecResolution;
  useGeneration: boolean;
}): string {
  const generationKey = resolveManagedNpmRootGenerationKey({
    packageName: params.packageName,
    npmResolution: params.npmResolution,
  });
  const npmRoot = resolveManagedNpmRootForInstall(params);
  const installRoot = resolveManagedNpmRootPackageDir(npmRoot, params.packageName);
  if (!hasRetainedManagedNpmInstallMarker(installRoot)) {
    return npmRoot;
  }
  // Never mutate a retained tree: an older process may still hold lazy imports
  // rooted there. A fresh activation root keeps that module graph importable.
  return resolvePluginNpmGenerationProjectDir({
    npmDir: params.npmBaseDir,
    packageName: params.packageName,
    generationKey: `${generationKey}\nactivation\n${randomUUID()}`,
  });
}

async function listManagedNpmPackageDirsForPackage(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  npmBaseDir: string;
  packageName: string;
}): Promise<string[]> {
  const packageDirs: string[] = [];
  const legacyProjectRoot = resolvePluginNpmProjectDir({
    npmDir: params.npmBaseDir,
    packageName: params.packageName,
  });
  const legacyPackageDir = resolveManagedNpmRootPackageDir(legacyProjectRoot, params.packageName);
  if (await params.runtime.fileExists(legacyPackageDir)) {
    packageDirs.push(legacyPackageDir);
  }
  const projectsDir = path.dirname(legacyProjectRoot);
  const generationPrefix = resolvePluginNpmGenerationProjectDirPrefix(params.packageName);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return packageDirs;
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(generationPrefix)) {
      continue;
    }
    const packageDir = resolveManagedNpmRootPackageDir(
      path.join(projectsDir, entry.name),
      params.packageName,
    );
    if (await params.runtime.fileExists(packageDir)) {
      packageDirs.push(packageDir);
    }
  }
  return packageDirs;
}

export async function resolveManagedNpmGenerationUseForInstall(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  npmBaseDir: string;
  packageName: string;
  requestedMode: "install" | "update";
  npmResolution?: NpmSpecResolution;
}): Promise<"none" | "update" | "retained-install"> {
  const packageDirs = await listManagedNpmPackageDirsForPackage({
    runtime: params.runtime,
    npmBaseDir: params.npmBaseDir,
    packageName: params.packageName,
  });
  const hasNonRetainedPackageDir = packageDirs.some(
    (packageDir) => !hasRetainedManagedNpmInstallMarker(packageDir),
  );
  if (packageDirs.length > 0 && !hasNonRetainedPackageDir) {
    return "retained-install";
  }
  const generationUse =
    params.requestedMode === "update" && hasNonRetainedPackageDir ? "update" : "none";
  if (params.npmResolution) {
    const candidateRoot = resolveManagedNpmRootForInstall({
      npmBaseDir: params.npmBaseDir,
      packageName: params.packageName,
      npmResolution: params.npmResolution,
      useGeneration: generationUse !== "none",
    });
    const candidatePackageDir = resolveManagedNpmRootPackageDir(candidateRoot, params.packageName);
    if (hasRetainedManagedNpmInstallMarker(candidatePackageDir)) {
      return "retained-install";
    }
  }
  if (params.requestedMode === "update") {
    return hasNonRetainedPackageDir ? "update" : "none";
  }
  return "none";
}

export function resolveRequiredPlatformPackageNames(
  packageMetadata?: OpenClawPackageManifest,
): { ok: true; packageNames: string[] } | { ok: false; error: string } {
  const raw = packageMetadata?.install?.requiredPlatformPackages as unknown;
  if (raw === undefined) {
    return { ok: true, packageNames: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: "package.json openclaw.install.requiredPlatformPackages must be an array",
    };
  }
  const packageNames = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") {
      return {
        ok: false,
        error:
          "package.json openclaw.install.requiredPlatformPackages must contain only npm package names",
      };
    }
    const specError = validateRegistryNpmSpec(value);
    const parsed = parseRegistryNpmSpec(value);
    if (specError || !parsed || parsed.selectorKind !== "none") {
      return {
        ok: false,
        error: `package.json openclaw.install.requiredPlatformPackages contains invalid package name: ${value}`,
      };
    }
    packageNames.add(parsed.name);
  }
  return { ok: true, packageNames: [...packageNames] };
}

export async function listNewManagedNpmRootPackageDirs(params: {
  beforeInstallPackageNames: Set<string>;
  npmRoot: string;
}): Promise<string[]> {
  const afterInstallPackageNames = await listManagedNpmRootPackageNames(params.npmRoot);
  return [...afterInstallPackageNames]
    .filter((packageName) => !params.beforeInstallPackageNames.has(packageName))
    .map((packageName) => resolveManagedNpmRootPackageDir(params.npmRoot, packageName))
    .toSorted((left, right) => left.localeCompare(right));
}
