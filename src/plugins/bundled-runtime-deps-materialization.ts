import fs from "node:fs";
import path from "node:path";
import { readRuntimeDepsJsonObject, type JsonObject } from "./bundled-runtime-deps-json.js";
import {
  collectPackageRuntimeDeps,
  normalizeRuntimeDepSpecs,
  parseInstallableRuntimeDep,
  parseInstallableRuntimeDepSpec,
  resolveDependencySentinelAbsolutePath,
} from "./bundled-runtime-deps-specs.js";
import { satisfies } from "./semver.runtime.js";

const LEGACY_RETAINED_RUNTIME_DEPS_MANIFEST = ".openclaw-runtime-deps.json";

function readGeneratedInstallManifestSpecs(installRoot: string): string[] | null {
  const parsed = readRuntimeDepsJsonObject(path.join(installRoot, "package.json"));
  if (parsed?.name !== "openclaw-runtime-deps-install") {
    return null;
  }
  const dependencies = parsed.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    return [];
  }
  const specs: string[] = [];
  for (const [name, version] of Object.entries(dependencies as Record<string, unknown>)) {
    const dep = parseInstallableRuntimeDep(name, version);
    if (dep) {
      specs.push(`${dep.name}@${dep.version}`);
    }
  }
  return normalizeRuntimeDepSpecs(specs);
}

function readPackageRuntimeDepSpecs(packageRoot: string): string[] | null {
  const parsed = readRuntimeDepsJsonObject(path.join(packageRoot, "package.json"));
  if (!parsed || parsed.name === "openclaw-runtime-deps-install") {
    return null;
  }
  const specs = Object.entries(collectPackageRuntimeDeps(parsed))
    .map(([name, rawVersion]) => parseInstallableRuntimeDep(name, rawVersion))
    .filter((dep): dep is { name: string; version: string } => Boolean(dep))
    .map((dep) => `${dep.name}@${dep.version}`);
  return normalizeRuntimeDepSpecs(specs);
}

function runtimeDepSpecsIncludeAll(
  availableSpecs: readonly string[],
  requestedSpecs: readonly string[],
): boolean {
  const available = new Set(normalizeRuntimeDepSpecs(availableSpecs));
  return normalizeRuntimeDepSpecs(requestedSpecs).every((spec) => available.has(spec));
}

function readInstalledRuntimeDepPackage(
  rootDir: string,
  depName: string,
): { packageDir: string; packageJson: JsonObject } | null {
  try {
    const packageJsonPath = resolveDependencySentinelAbsolutePath(rootDir, depName);
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return { packageDir: path.dirname(packageJsonPath), packageJson: parsed as JsonObject };
  } catch {
    return null;
  }
}

function hasRuntimeDepEntryFile(packageDir: string, rawEntry: string): boolean {
  const entry = rawEntry.trim();
  if (entry === "") {
    return true;
  }
  const entryPath = path.resolve(packageDir, entry);
  if (entryPath !== packageDir && !entryPath.startsWith(`${packageDir}${path.sep}`)) {
    return false;
  }
  if (fs.existsSync(entryPath)) {
    return true;
  }
  return (
    fs.existsSync(`${entryPath}.js`) ||
    fs.existsSync(`${entryPath}.json`) ||
    fs.existsSync(`${entryPath}.node`) ||
    fs.existsSync(path.join(entryPath, "index.js")) ||
    fs.existsSync(path.join(entryPath, "index.json")) ||
    fs.existsSync(path.join(entryPath, "index.node"))
  );
}

function hasInstalledRuntimeDepEntryFiles(packageDir: string, packageJson: JsonObject): boolean {
  const main = packageJson.main;
  if (typeof main === "string") {
    return hasRuntimeDepEntryFile(packageDir, main);
  }
  if (packageJson.exports !== undefined) {
    return true;
  }
  return hasRuntimeDepEntryFile(packageDir, "index");
}

function isRuntimeDepSatisfied(rootDir: string, dep: { name: string; version: string }): boolean {
  const installed = readInstalledRuntimeDepPackage(rootDir, dep.name);
  if (!installed) {
    return false;
  }
  const version = installed.packageJson.version;
  return Boolean(
    typeof version === "string" &&
    version.trim() &&
    satisfies(version.trim(), dep.version) &&
    hasInstalledRuntimeDepEntryFiles(installed.packageDir, installed.packageJson),
  );
}

export function isRuntimeDepSatisfiedInAnyRoot(
  dep: { name: string; version: string },
  roots: readonly string[],
): boolean {
  return roots.some((root) => isRuntimeDepSatisfied(root, dep));
}

function hasSatisfiedInstallSpecPackages(rootDir: string, specs: readonly string[]): boolean {
  return specs
    .map(parseInstallableRuntimeDepSpec)
    .every((dep) => isRuntimeDepSatisfied(rootDir, dep));
}

export function isRuntimeDepsPlanMaterialized(
  installRoot: string,
  installSpecs: readonly string[],
): boolean {
  const generatedManifestSpecs = readGeneratedInstallManifestSpecs(installRoot);
  const packageManifestSpecs =
    generatedManifestSpecs !== null ? null : readPackageRuntimeDepSpecs(installRoot);
  return (
    ((generatedManifestSpecs !== null &&
      runtimeDepSpecsIncludeAll(generatedManifestSpecs, installSpecs)) ||
      (packageManifestSpecs !== null &&
        runtimeDepSpecsIncludeAll(packageManifestSpecs, installSpecs))) &&
    hasSatisfiedInstallSpecPackages(installRoot, installSpecs)
  );
}

export function assertBundledRuntimeDepsInstalled(rootDir: string, specs: readonly string[]): void {
  const missingSpecs = specs.filter((spec) => {
    const dep = parseInstallableRuntimeDepSpec(spec);
    return !isRuntimeDepSatisfied(rootDir, dep);
  });
  if (missingSpecs.length === 0) {
    return;
  }
  throw new Error(
    `package manager install did not place bundled runtime deps in ${rootDir}: ${missingSpecs.join(", ")}`,
  );
}

export function removeLegacyRuntimeDepsManifest(installRoot: string): void {
  fs.rmSync(path.join(installRoot, LEGACY_RETAINED_RUNTIME_DEPS_MANIFEST), {
    force: true,
  });
}

export function removeRuntimeDepsNodeModulesSymlink(installRoot: string): boolean {
  const nodeModulesPath = path.join(installRoot, "node_modules");
  try {
    if (!fs.lstatSync(nodeModulesPath).isSymbolicLink()) {
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  fs.unlinkSync(nodeModulesPath);
  return true;
}

export function linkRuntimeDepsNodeModulesFromRoot(params: {
  sourceRoot: string;
  targetRoot: string;
}): boolean {
  const sourceNodeModules = path.join(params.sourceRoot, "node_modules");
  const targetNodeModules = path.join(params.targetRoot, "node_modules");
  if (path.resolve(sourceNodeModules) === path.resolve(targetNodeModules)) {
    return true;
  }
  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.lstatSync(sourceNodeModules);
  } catch {
    return false;
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    return false;
  }
  try {
    fs.lstatSync(targetNodeModules);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  fs.mkdirSync(params.targetRoot, { recursive: true });
  const linkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(sourceNodeModules, targetNodeModules, linkType);
  return true;
}

function createNpmInstallExecutionManifest(installSpecs: readonly string[]): JsonObject {
  const dependencies: Record<string, string> = {};
  for (const spec of installSpecs) {
    const dep = parseInstallableRuntimeDepSpec(spec);
    dependencies[dep.name] = dep.version;
  }
  const sortedDependencies = Object.fromEntries(
    Object.entries(dependencies).toSorted(([left], [right]) => left.localeCompare(right)),
  );
  return {
    name: "openclaw-runtime-deps-install",
    private: true,
    dependencies: sortedDependencies,
  };
}

export function ensureNpmInstallExecutionManifest(
  installExecutionRoot: string,
  installSpecs: readonly string[] = [],
): void {
  const manifestPath = path.join(installExecutionRoot, "package.json");
  const manifest = createNpmInstallExecutionManifest(installSpecs);
  const nextContents = `${JSON.stringify(manifest, null, 2)}\n`;
  if (fs.existsSync(manifestPath) && fs.readFileSync(manifestPath, "utf8") === nextContents) {
    return;
  }
  fs.writeFileSync(manifestPath, nextContents, "utf8");
}
