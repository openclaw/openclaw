import fs from "node:fs/promises";
import path from "node:path";
import type { NpmSpecResolution } from "./install-source-utils.js";
import { readJson, readJsonIfExists, writeJson } from "./json-files.js";
import type { ParsedRegistryNpmSpec } from "./npm-registry-spec.js";

const MANAGED_ROOT_MARKER = "openclawManagedPluginRoot";

type ManagedNpmRootManifest = {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  openclawManagedPluginRoot?: boolean;
  [key: string]: unknown;
};

export type ManagedNpmRootInstalledDependency = {
  version?: string;
  integrity?: string;
  resolved?: string;
};

type ManagedNpmRootLockfile = {
  packages?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ManagedNpmRootOpenClawPoison = {
  hasPoison: boolean;
  lockfileParseError?: string;
  lockfileRootDependency: boolean;
  lockfileTopLevelPackage: boolean;
  manifestFields: string[];
  rootPackageDir: boolean;
};

export type ManagedNpmRootRepairResult = {
  changed: boolean;
  reason?: string;
  status: "repaired" | "skipped" | "unchanged";
  warnings: string[];
};

export type ManagedNpmRootCommandResult = {
  code: number | null;
  stderr: string;
  stdout: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readDependencyRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const dependencies: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      dependencies[key] = raw;
    }
  }
  return dependencies;
}

async function readManagedNpmRootManifest(filePath: string): Promise<ManagedNpmRootManifest> {
  const parsed = await readJsonIfExists<unknown>(filePath);
  return isRecord(parsed) ? { ...parsed } : {};
}

async function writeManagedNpmRootManifest(
  filePath: string,
  manifest: ManagedNpmRootManifest,
): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function pathsEqual(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && path.resolve(left) === path.resolve(right));
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  return pathsEqual(left, right) || pathContains(left, right) || pathContains(right, left);
}

function removeOpenClawFromDependencyFields(manifest: ManagedNpmRootManifest): {
  changed: boolean;
  manifest: ManagedNpmRootManifest;
} {
  let changed = false;
  const next: ManagedNpmRootManifest = { ...manifest };
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const dependencies = readDependencyRecord(next[field]);
    if (!Object.hasOwn(dependencies, "openclaw")) {
      continue;
    }
    const { openclaw: _removed, ...remaining } = dependencies;
    next[field] = remaining;
    changed = true;
  }
  return { changed, manifest: next };
}

async function quarantinePath(params: {
  npmRoot: string;
  sourcePath: string;
  label: string;
  now: () => number;
}): Promise<boolean> {
  if (!(await pathExists(params.sourcePath))) {
    return false;
  }
  const quarantineDir = path.join(params.npmRoot, ".openclaw-quarantine");
  await fs.mkdir(quarantineDir, { recursive: true });
  const targetPath = path.join(quarantineDir, `${params.label}-${params.now()}`);
  await fs.rename(params.sourcePath, targetPath).catch(async () => {
    await fs.rm(params.sourcePath, { recursive: true, force: true });
  });
  return true;
}

export function resolveManagedNpmRootDependencySpec(params: {
  parsedSpec: ParsedRegistryNpmSpec;
  resolution: NpmSpecResolution;
}): string {
  return params.resolution.version ?? params.parsedSpec.selector ?? "latest";
}

export async function upsertManagedNpmRootDependency(params: {
  npmRoot: string;
  packageName: string;
  dependencySpec: string;
}): Promise<void> {
  await fs.mkdir(params.npmRoot, { recursive: true });
  const manifestPath = path.join(params.npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  const dependencies = readDependencyRecord(manifest.dependencies);
  const next: ManagedNpmRootManifest = {
    ...manifest,
    private: true,
    dependencies: {
      ...dependencies,
      [params.packageName]: params.dependencySpec,
    },
  };
  await writeJson(manifestPath, next, { trailingNewline: true });
}

export async function inspectManagedNpmRootOpenClawPoison(params: {
  npmRoot: string;
}): Promise<ManagedNpmRootOpenClawPoison> {
  const manifest = await readManagedNpmRootManifest(path.join(params.npmRoot, "package.json"));
  const manifestFields = ["dependencies", "optionalDependencies", "peerDependencies"].filter(
    (field) => Object.hasOwn(readDependencyRecord(manifest[field]), "openclaw"),
  );
  let lockfileParseError: string | undefined;
  let lockfileRootDependency = false;
  let lockfileTopLevelPackage = false;

  const lockPath = path.join(params.npmRoot, "package-lock.json");
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as ManagedNpmRootLockfile;
    if (isRecord(parsed.packages)) {
      const rootPackage = parsed.packages[""];
      lockfileRootDependency =
        isRecord(rootPackage) &&
        isRecord(rootPackage.dependencies) &&
        Object.hasOwn(rootPackage.dependencies, "openclaw");
      lockfileTopLevelPackage = Object.hasOwn(parsed.packages, "node_modules/openclaw");
    }
    lockfileRootDependency =
      lockfileRootDependency ||
      (isRecord(parsed.dependencies) && Object.hasOwn(parsed.dependencies, "openclaw"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      lockfileParseError = String(err);
    }
  }

  const rootPackageDir = await pathExists(path.join(params.npmRoot, "node_modules", "openclaw"));
  return {
    hasPoison:
      manifestFields.length > 0 ||
      lockfileRootDependency ||
      lockfileTopLevelPackage ||
      rootPackageDir ||
      Boolean(lockfileParseError),
    ...(lockfileParseError ? { lockfileParseError } : {}),
    lockfileRootDependency,
    lockfileTopLevelPackage,
    manifestFields,
    rootPackageDir,
  };
}

async function isUnsafeManagedNpmRoot(params: {
  hostPackageRoot?: string | null;
  npmRoot: string;
}): Promise<string | null> {
  const manifestPath = path.join(params.npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  if (manifest.name === "openclaw") {
    return "root package is openclaw";
  }
  if (params.hostPackageRoot && pathsOverlap(params.npmRoot, params.hostPackageRoot)) {
    return "root overlaps the running openclaw package";
  }
  if (await pathExists(path.join(params.npmRoot, "pnpm-workspace.yaml"))) {
    return "root is a pnpm workspace";
  }
  return null;
}

async function ensureManagedRootMarker(npmRoot: string): Promise<void> {
  await fs.mkdir(npmRoot, { recursive: true });
  const manifestPath = path.join(npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  if (manifest.private === true && manifest.openclawManagedPluginRoot === true) {
    return;
  }
  await writeManagedNpmRootManifest(manifestPath, {
    ...manifest,
    private: true,
    [MANAGED_ROOT_MARKER]: true,
  });
}

function isManagedNpmRootProven(params: {
  defaultNpmRoot?: string;
  npmRoot: string;
  trustedByInstallRecord?: boolean;
  manifest: ManagedNpmRootManifest;
}): boolean {
  return (
    pathsEqual(params.npmRoot, params.defaultNpmRoot) ||
    params.trustedByInstallRecord ||
    params.manifest.openclawManagedPluginRoot === true
  );
}

async function runNativeOpenClawRootRepair(params: {
  env: NodeJS.ProcessEnv;
  npmRoot: string;
  runCommand: (
    argv: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  ) => Promise<ManagedNpmRootCommandResult>;
  timeoutMs: number;
}): Promise<string[]> {
  const warnings: string[] = [];
  const commands = [
    [
      "npm",
      "uninstall",
      "--loglevel=error",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      ".",
      "openclaw",
    ],
    [
      "npm",
      "prune",
      "--omit=dev",
      "--loglevel=error",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      ".",
    ],
  ];
  for (const argv of commands) {
    try {
      const result = await params.runCommand(argv, {
        cwd: params.npmRoot,
        timeoutMs: Math.max(params.timeoutMs, 300_000),
        env: params.env,
      });
      if (result.code !== 0) {
        warnings.push(`${argv.slice(0, 2).join(" ")} failed: ${result.stderr || result.stdout}`);
      }
    } catch (err) {
      warnings.push(`${argv.slice(0, 2).join(" ")} failed: ${String(err)}`);
    }
  }
  return warnings;
}

async function fallbackRepairManagedRoot(params: {
  now: () => number;
  npmRoot: string;
}): Promise<boolean> {
  let changed = false;
  await ensureManagedRootMarker(params.npmRoot);

  const manifestPath = path.join(params.npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  const cleaned = removeOpenClawFromDependencyFields(manifest);
  if (cleaned.changed) {
    await writeManagedNpmRootManifest(manifestPath, {
      ...cleaned.manifest,
      private: true,
      [MANAGED_ROOT_MARKER]: true,
    });
    changed = true;
  }

  const lockPath = path.join(params.npmRoot, "package-lock.json");
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as ManagedNpmRootLockfile;
    let lockChanged = false;
    if (isRecord(parsed.packages)) {
      const rootPackage = parsed.packages[""];
      if (isRecord(rootPackage) && isRecord(rootPackage.dependencies)) {
        const dependencies = { ...rootPackage.dependencies };
        if ("openclaw" in dependencies) {
          delete dependencies.openclaw;
          parsed.packages[""] = { ...rootPackage, dependencies };
          lockChanged = true;
        }
      }
      if ("node_modules/openclaw" in parsed.packages) {
        delete parsed.packages["node_modules/openclaw"];
        lockChanged = true;
      }
    }
    if (isRecord(parsed.dependencies) && "openclaw" in parsed.dependencies) {
      const dependencies = { ...parsed.dependencies };
      delete dependencies.openclaw;
      parsed.dependencies = dependencies;
      lockChanged = true;
    }
    if (lockChanged) {
      await fs.writeFile(lockPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      changed = true;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      changed =
        (await quarantinePath({
          npmRoot: params.npmRoot,
          sourcePath: lockPath,
          label: "package-lock-json",
          now: params.now,
        })) || changed;
    }
  }

  changed =
    (await quarantinePath({
      npmRoot: params.npmRoot,
      sourcePath: path.join(params.npmRoot, "node_modules", "openclaw"),
      label: "node_modules-openclaw",
      now: params.now,
    })) || changed;

  return changed;
}

export async function repairManagedNpmRootOpenClawPeer(params: {
  defaultNpmRoot?: string;
  env: NodeJS.ProcessEnv;
  hostPackageRoot?: string | null;
  now?: () => number;
  npmRoot: string;
  runCommand: (
    argv: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  ) => Promise<ManagedNpmRootCommandResult>;
  timeoutMs: number;
  trustedByInstallRecord?: boolean;
}): Promise<ManagedNpmRootRepairResult> {
  const npmRoot = path.resolve(params.npmRoot);
  await fs.mkdir(npmRoot, { recursive: true });
  const warnings: string[] = [];
  const poison = await inspectManagedNpmRootOpenClawPoison({ npmRoot });
  if (!poison.hasPoison) {
    return { changed: false, status: "unchanged", warnings };
  }

  const unsafeReason = await isUnsafeManagedNpmRoot({
    hostPackageRoot: params.hostPackageRoot,
    npmRoot,
  });
  if (unsafeReason) {
    return { changed: false, reason: unsafeReason, status: "skipped", warnings };
  }

  const manifest = await readManagedNpmRootManifest(path.join(npmRoot, "package.json"));
  if (
    !isManagedNpmRootProven({
      defaultNpmRoot: params.defaultNpmRoot,
      npmRoot,
      trustedByInstallRecord: params.trustedByInstallRecord,
      manifest,
    })
  ) {
    return {
      changed: false,
      reason: "root is not a proven OpenClaw-managed npm root",
      status: "skipped",
      warnings,
    };
  }

  await ensureManagedRootMarker(npmRoot);
  warnings.push(
    ...(await runNativeOpenClawRootRepair({
      env: params.env,
      npmRoot,
      runCommand: params.runCommand,
      timeoutMs: params.timeoutMs,
    })),
  );
  const afterNative = await inspectManagedNpmRootOpenClawPoison({ npmRoot });
  if (!afterNative.hasPoison) {
    return { changed: true, status: "repaired", warnings };
  }

  const fallbackChanged = await fallbackRepairManagedRoot({
    now: params.now ?? Date.now,
    npmRoot,
  });
  const afterFallback = await inspectManagedNpmRootOpenClawPoison({ npmRoot });
  if (afterFallback.hasPoison) {
    return {
      changed: fallbackChanged,
      reason: "root still contains stale openclaw package state after repair",
      status: "skipped",
      warnings,
    };
  }
  return { changed: true, status: "repaired", warnings };
}

export async function readManagedNpmRootInstalledDependency(params: {
  npmRoot: string;
  packageName: string;
}): Promise<ManagedNpmRootInstalledDependency | null> {
  const lockPath = path.join(params.npmRoot, "package-lock.json");
  const parsed = await readJson<unknown>(lockPath);
  if (!isRecord(parsed) || !isRecord(parsed.packages)) {
    return null;
  }
  const entry = parsed.packages[`node_modules/${params.packageName}`];
  if (!isRecord(entry)) {
    return null;
  }
  return {
    version: readOptionalString(entry.version),
    integrity: readOptionalString(entry.integrity),
    resolved: readOptionalString(entry.resolved),
  };
}

export async function removeManagedNpmRootDependency(params: {
  npmRoot: string;
  packageName: string;
}): Promise<void> {
  const manifestPath = path.join(params.npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  const dependencies = readDependencyRecord(manifest.dependencies);
  if (!(params.packageName in dependencies)) {
    return;
  }
  const { [params.packageName]: _removed, ...nextDependencies } = dependencies;
  const next: ManagedNpmRootManifest = {
    ...manifest,
    private: true,
    dependencies: nextDependencies,
  };
  await writeJson(manifestPath, next, { trailingNewline: true });
}
