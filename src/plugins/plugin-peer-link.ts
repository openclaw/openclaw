import { lstatSync, symlinkSync, unlinkSync, type Stats } from "node:fs";
// Owns installed plugin host links and standalone build identity admission.
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  getEmbeddedStandaloneRuntimeRoot,
  isStandaloneRuntimeExecutable,
  readStandaloneRuntimeManifest,
  readStandaloneRuntimeManifestForRoot,
} from "../../cli-invocation.mjs";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { ignoreMissingPath } from "../infra/errno.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { readRootJsonObjectSync } from "../infra/json-files.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolvePluginInstallDir } from "./install-paths.js";
import type { InstalledPluginIndexStoreOptions } from "./installed-plugin-index-store-path.js";
import { listNpmPackageDirs } from "./npm-package-dirs.js";
import { safeRealpathSync } from "./path-safety.js";
import {
  loadPluginCohortProtectedArtifacts,
  type PluginCohortProtectedArtifacts,
} from "./update-cohort-protected-artifacts.js";

type PluginPeerLinkLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type RelinkManagedNpmRootResult = {
  repaired: number;
};

export type OpenClawPeerLinkAuditIssue = {
  packageName: string;
  packageDir: string;
  reason: string;
};

type AuditManagedNpmRootResult = {
  issues: OpenClawPeerLinkAuditIssue[];
};

type OpenClawPeerLinkResult = "linked" | "skipped" | "unchanged";

type OpenClawHostDependency = {
  declaration: "peerDependencies" | "dependencies" | "optionalDependencies";
  spec: string;
};

type RegisteredOpenClawHostLinkResult = {
  repaired: number;
  issues: OpenClawPeerLinkAuditIssue[];
};

/** Resolve the host declaration consistently for peer, direct, and optional dependencies. */
export function resolveOpenClawHostDependency(manifest: {
  dependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
}): OpenClawHostDependency | null {
  for (const declaration of ["peerDependencies", "optionalDependencies", "dependencies"] as const) {
    const spec = asOptionalRecord(manifest[declaration])?.openclaw;
    if (typeof spec === "string" && spec) {
      return { declaration, spec };
    }
  }
  return null;
}

async function readSafePackageManifest(
  packageDir: string,
): Promise<Record<string, unknown> | null> {
  const result = readRootJsonObjectSync({
    rootDir: packageDir,
    relativePath: "package.json",
    boundaryLabel: "installed plugin package directory",
  });
  if (!result.ok) {
    if (
      result.reason === "open" &&
      (result.failure.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    ) {
      return null;
    }
    if (result.reason === "parse") {
      throw new SyntaxError(result.error);
    }
    if (result.reason === "open" && result.failure.error instanceof Error) {
      throw result.failure.error;
    }
    throw new Error(
      `Could not safely read package.json from ${packageDir}: ${
        result.reason === "open" ? result.failure.reason : result.error
      }`,
    );
  }
  return result.value;
}

async function readPackageOpenClawLinkDependencies(
  packageDir: string,
  onPackageReadError?: (error: unknown, packageDir: string) => void,
): Promise<Record<string, string> | undefined> {
  try {
    const manifest = await readSafePackageManifest(packageDir);
    const dependency = manifest ? resolveOpenClawHostDependency(manifest) : null;
    return dependency ? { openclaw: dependency.spec } : undefined;
  } catch (error) {
    if (!onPackageReadError) {
      throw error;
    }
    onPackageReadError(error, packageDir);
    return undefined;
  }
}

async function listManagedNpmRootPackageDirs(npmRoot: string): Promise<string[]> {
  const packageDirs = await listNpmPackageDirs(npmRoot, {
    includeEntry: (entry, scoped) => entry.isDirectory() && (scoped || !entry.name.startsWith(".")),
  });
  return packageDirs.toSorted((a, b) => a.localeCompare(b));
}

async function safeRealpath(filePath: string): Promise<string | null> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return null;
  }
}

function managedPackageNameFromDir(params: { npmRoot: string; packageDir: string }): string {
  return path
    .relative(path.join(params.npmRoot, "node_modules"), params.packageDir)
    .split(path.sep)
    .join("/");
}

function resolveOpenClawHostRoot(): string | null {
  const embeddedRoot = getEmbeddedStandaloneRuntimeRoot();
  if (embeddedRoot) {
    return safeRealpathSync(embeddedRoot) ?? embeddedRoot;
  }
  const manifest = readStandaloneRuntimeManifest();
  return manifest
    ? path.resolve(path.dirname(process.execPath), manifest.runtime.path)
    : resolveOpenClawPackageRootSync({
        argv1: process.argv[1],
        moduleUrl: import.meta.url,
        cwd: process.cwd(),
      });
}

/** Loose installs select a path; relocated standalone copies select the same immutable build. */
export function openClawHostRootsMatch(currentRoot: string, expectedRoot: string): boolean {
  const current = safeRealpathSync(currentRoot);
  const expected = safeRealpathSync(expectedRoot);
  if (!current || !expected) {
    return false;
  }
  if (current === expected) {
    return true;
  }
  try {
    const left = readStandaloneRuntimeManifestForRoot(current);
    const right = readStandaloneRuntimeManifestForRoot(expected);
    // Version alone also matches upgrades; require the packaged code and sidecar identities.
    return Boolean(
      left?.openclaw.commit &&
      left.executable.sha256 &&
      left.runtime.sha256 &&
      right &&
      left.openclaw.commit === right.openclaw.commit &&
      left.openclaw.version === right.openclaw.version &&
      left.executable.sha256 === right.executable.sha256 &&
      left.runtime.sha256 === right.runtime.sha256,
    );
  } catch {
    // Invalid or absent peer identity never widens the existing path admission.
    return false;
  }
}

function auditOpenClawPeerDependency(params: {
  hostRoot: string;
  packageDir: string;
  npmRoot?: string;
  packageName?: string;
}): OpenClawPeerLinkAuditIssue | null {
  const packageName =
    params.packageName ??
    (params.npmRoot
      ? managedPackageNameFromDir({
          npmRoot: params.npmRoot,
          packageDir: params.packageDir,
        })
      : path.basename(params.packageDir));
  const issue = (reason: string): OpenClawPeerLinkAuditIssue => ({
    packageName,
    packageDir: params.packageDir,
    reason: isStandaloneRuntimeExecutable()
      ? reason + ". Run `openclaw doctor --fix` with the selected runtime, then restart the Gateway"
      : reason,
  });
  const nodeModulesDir = path.join(params.packageDir, "node_modules");
  try {
    const existing = lstatSync(nodeModulesDir);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      return issue(`${nodeModulesDir} is not a real directory`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return issue(`missing ${path.join(nodeModulesDir, "openclaw")}`);
    }
    throw error;
  }

  const linkPath = path.join(nodeModulesDir, "openclaw");
  const currentTarget = safeRealpathSync(linkPath);
  if (!currentTarget) {
    return issue(`missing ${linkPath}`);
  }
  const expectedTarget = safeRealpathSync(params.hostRoot) ?? params.hostRoot;
  if (!openClawHostRootsMatch(currentTarget, expectedTarget)) {
    return issue(`${linkPath} points to ${currentTarget} instead of ${expectedTarget}`);
  }
  return null;
}

export function auditOpenClawPeerDependencyLinkSync(params: {
  packageDir: string;
  packageName?: string;
}): OpenClawPeerLinkAuditIssue | null {
  const packageName = params.packageName ?? path.basename(params.packageDir);
  const hostRoot = resolveOpenClawHostRoot();
  if (!hostRoot) {
    return {
      packageName,
      packageDir: params.packageDir,
      reason: "could not locate openclaw package root",
    };
  }
  return auditOpenClawPeerDependency({
    hostRoot,
    packageDir: params.packageDir,
    packageName,
  });
}

export async function auditOpenClawPeerDependencyLink(
  params: Parameters<typeof auditOpenClawPeerDependencyLinkSync>[0],
): Promise<OpenClawPeerLinkAuditIssue | null> {
  return auditOpenClawPeerDependencyLinkSync(params);
}

/** Audit the installed host only when the package actually declares an OpenClaw dependency. */
export async function auditDeclaredOpenClawHostDependency(params: {
  packageDir: string;
  packageName?: string;
}): Promise<OpenClawPeerLinkAuditIssue | null> {
  const dependencies = await readPackageOpenClawLinkDependencies(params.packageDir);
  if (!dependencies) {
    return null;
  }
  return await auditOpenClawPeerDependencyLink(params);
}

async function ensureRealNodeModulesDir(params: {
  installedDir: string;
  logger: PluginPeerLinkLogger;
  beforePersistentApply?: () => void;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<string | null> {
  const nodeModulesDir = path.join(params.installedDir, "node_modules");
  let existing: Stats | undefined;
  try {
    existing = await fs.lstat(nodeModulesDir);
  } catch (error) {
    ignoreMissingPath(error);
  }
  if (!existing) {
    await params.beforePersistentEffect?.();
    params.beforePersistentApply?.();
    await fs.mkdir(nodeModulesDir, { recursive: true });
    existing = await fs.lstat(nodeModulesDir);
  }
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    params.logger.warn?.(
      `Skipping openclaw peerDependency link because ${nodeModulesDir} is not a real directory.`,
    );
    return null;
  }
  return nodeModulesDir;
}

async function linkOpenClawPeerDependency(params: {
  hostRoot: string;
  installedDir: string;
  logger: PluginPeerLinkLogger;
  beforePersistentApply?: () => void;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<OpenClawPeerLinkResult> {
  const nodeModulesDir = await ensureRealNodeModulesDir(params);
  if (!nodeModulesDir) {
    return "skipped";
  }

  const linkPath = path.join(nodeModulesDir, "openclaw");
  const expectedTarget = (await safeRealpath(params.hostRoot)) ?? params.hostRoot;
  const currentTarget = await safeRealpath(linkPath);
  // Explicit install/repair always rebinds a relocated copy to this runtime, even for the same build.
  if (currentTarget === expectedTarget) {
    return "unchanged";
  }

  const warn = (error: unknown): "skipped" => {
    params.beforePersistentApply?.();
    params.logger.warn?.(`Failed to symlink peerDependency "openclaw": ${String(error)}`);
    return "skipped";
  };
  let existing: Stats | null;
  let previousTarget = currentTarget;
  try {
    existing = await fs.lstat(linkPath).catch((error: unknown) => {
      ignoreMissingPath(error);
      return null;
    });
    if (existing?.isSymbolicLink()) {
      previousTarget = path.resolve(nodeModulesDir, await fs.readlink(linkPath));
    }
    if (
      existing &&
      !existing.isSymbolicLink() &&
      (!existing.isDirectory() || (await readPackageName(linkPath)) !== "openclaw")
    ) {
      params.logger.warn?.(
        `Skipping openclaw peerDependency link because ${linkPath} already exists and is not a symlink.`,
      );
      return "skipped";
    }
  } catch (error) {
    return warn(error);
  }
  // Await the initiating owner's effect gate, then revalidate synchronous
  // mutation authority outside filesystem warning conversion before each effect.
  if (existing) {
    await params.beforePersistentEffect?.();
    params.beforePersistentApply?.();
    try {
      if (existing.isSymbolicLink()) {
        unlinkSync(linkPath);
      } else {
        await fs.rm(linkPath, { recursive: true, force: true });
      }
    } catch (error) {
      return warn(error);
    }
  }
  await params.beforePersistentEffect?.();
  params.beforePersistentApply?.();
  try {
    symlinkSync(params.hostRoot, linkPath, "junction");
    if (previousTarget) {
      params.logger.warn?.(
        `Repaired OpenClaw host link at ${linkPath}: ${previousTarget} -> ${expectedTarget}`,
      );
    }
    params.logger.info?.(`Linked peerDependency "openclaw" -> ${params.hostRoot}`);
    return "linked";
  } catch (error) {
    return warn(error);
  }
}

async function readPackageName(packageDir: string): Promise<string | undefined> {
  const manifest = await readSafePackageManifest(packageDir);
  return typeof manifest?.name === "string" ? manifest.name : undefined;
}

/**
 * Symlink the host openclaw package for plugins that declare it as a dependency.
 * Plugin package managers still own third-party dependencies; this only wires
 * the host SDK package into the plugin-local Node graph.
 */
export async function linkOpenClawPeerDependencies(params: {
  installedDir: string;
  peerDependencies: Record<string, string>;
  logger: PluginPeerLinkLogger;
  /** Explicit source setup uses its selected checkout instead of the running host. */
  hostRoot?: string;
  beforePersistentApply?: () => void;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<{ repaired: number; skipped: number }> {
  if (!Object.keys(params.peerDependencies).includes("openclaw")) {
    return { repaired: 0, skipped: 0 };
  }

  const hostRoot = params.hostRoot ?? resolveOpenClawHostRoot();
  if (!hostRoot) {
    params.logger.warn?.(
      "Could not locate openclaw package root to symlink peerDependencies; plugin may fail to resolve openclaw at runtime.",
    );
    return { repaired: 0, skipped: 1 };
  }

  const result = await linkOpenClawPeerDependency({ ...params, hostRoot });
  return { repaired: result === "linked" ? 1 : 0, skipped: result === "skipped" ? 1 : 0 };
}

/**
 * Repair registered package installs named by the authoritative install ledger.
 * Local/path installs and symlink escapes remain developer-owned and are never mutated.
 */
export async function reconcileRegisteredOpenClawHostLinks(
  params: InstalledPluginIndexStoreOptions & {
    installRecords: Record<string, PluginInstallRecord>;
    extensionsDir: string;
    mode: "audit" | "repair";
    logger?: PluginPeerLinkLogger;
    onPackageReadError?: (error: unknown, packageDir: string) => void;
    beforePersistentApply?: () => void;
    beforePersistentEffect?: () => void | Promise<void>;
  },
): Promise<RegisteredOpenClawHostLinkResult> {
  return await reconcileRegisteredHostLinks(
    params,
    params.mode === "repair" ? await loadPluginCohortProtectedArtifacts(params) : undefined,
  );
}

async function reconcileRegisteredHostLinks(
  params: Parameters<typeof reconcileRegisteredOpenClawHostLinks>[0],
  protectedArtifacts: PluginCohortProtectedArtifacts | undefined,
): Promise<RegisteredOpenClawHostLinkResult> {
  const extensionsRoot = path.resolve(params.extensionsDir);
  const extensionsRootRealPath = await safeRealpath(extensionsRoot);
  if (!extensionsRootRealPath) {
    return { repaired: 0, issues: [] };
  }

  let repaired = 0;
  const issues: OpenClawPeerLinkAuditIssue[] = [];
  for (const [pluginId, record] of Object.entries(params.installRecords).toSorted(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (
      (record.source !== "npm" && record.source !== "clawhub" && record.source !== "archive") ||
      !record.installPath?.trim()
    ) {
      continue;
    }

    let packageDir: string;
    let expectedPackageDir: string;
    try {
      packageDir = path.resolve(resolveUserPath(record.installPath, params.env));
      expectedPackageDir = path.resolve(resolvePluginInstallDir(pluginId, extensionsRoot));
    } catch {
      continue;
    }
    if (packageDir !== expectedPackageDir) {
      continue;
    }

    const packageRealPath = await safeRealpath(packageDir);
    const expectedPackageRealPath = path.join(
      extensionsRootRealPath,
      path.relative(extensionsRoot, expectedPackageDir),
    );
    // Ledger paths cannot alias an outside directory or another developer-owned plugin in this root.
    if (
      !packageRealPath ||
      !isPathInside(extensionsRootRealPath, packageRealPath) ||
      packageRealPath !== expectedPackageRealPath
    ) {
      continue;
    }

    const dependencies = await readPackageOpenClawLinkDependencies(
      packageDir,
      params.onPackageReadError,
    );
    if (!dependencies) {
      continue;
    }
    const issue = await auditOpenClawPeerDependencyLink({
      packageDir,
      packageName: pluginId,
    });
    if (issue) {
      issues.push(issue);
    }
    if (params.mode !== "repair") {
      continue;
    }
    if (record.source === "npm" && protectedArtifacts?.includesPackageDir(packageDir)) {
      continue;
    }

    const result = await linkOpenClawPeerDependencies({
      installedDir: packageDir,
      peerDependencies: dependencies,
      logger: params.logger ?? {},
      beforePersistentApply: params.beforePersistentApply,
      beforePersistentEffect: params.beforePersistentEffect,
    });
    repaired += result.repaired;
  }
  return { repaired, issues };
}

// Admitted repairs must settle before rejection; siblings must not keep
// mutating after their lifecycle owner has reported failure.
export async function repairInstalledOpenClawHostLinks(
  params: InstalledPluginIndexStoreOptions & {
    managedNpmRoots: string[];
    installRecords: Record<string, PluginInstallRecord>;
    extensionsDir: string;
    logger: PluginPeerLinkLogger;
    onPackageReadError?: (
      error: unknown,
      packageDir: string,
      kind: "managed npm" | "registered",
    ) => void;
    beforePersistentApply?: () => void;
    beforePersistentEffect?: () => void | Promise<void>;
  },
): Promise<{ managedRepaired: number; registeredRepaired: number }> {
  const protectedArtifacts = await loadPluginCohortProtectedArtifacts(params);
  const onPackageReadError = params.onPackageReadError;
  const results = await Promise.allSettled(
    params.managedNpmRoots.map((npmRoot) =>
      relinkManagedNpmRoot(
        {
          ...params,
          npmRoot,
          onPackageReadError: onPackageReadError
            ? (error, packageDir) => onPackageReadError(error, packageDir, "managed npm")
            : undefined,
        },
        protectedArtifacts,
      ),
    ),
  );
  let managedRepaired = 0;
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
    managedRepaired += result.value.repaired;
  }
  const registered = await reconcileRegisteredHostLinks(
    {
      ...params,
      mode: "repair",
      onPackageReadError: onPackageReadError
        ? (error, packageDir) => onPackageReadError(error, packageDir, "registered")
        : undefined,
    },
    protectedArtifacts,
  );
  return { managedRepaired, registeredRepaired: registered.repaired };
}

export async function relinkOpenClawPeerDependenciesInManagedNpmRoot(
  params: InstalledPluginIndexStoreOptions & {
    npmRoot: string;
    beforePersistentApply?: () => void;
    logger: PluginPeerLinkLogger;
    onPackageReadError?: (error: unknown, packageDir: string) => void;
    beforePersistentEffect?: () => void | Promise<void>;
  },
): Promise<RelinkManagedNpmRootResult> {
  return await relinkManagedNpmRoot(params, await loadPluginCohortProtectedArtifacts(params));
}

async function relinkManagedNpmRoot(
  params: Parameters<typeof relinkOpenClawPeerDependenciesInManagedNpmRoot>[0],
  protectedArtifacts: PluginCohortProtectedArtifacts,
): Promise<RelinkManagedNpmRootResult> {
  if (protectedArtifacts.includesNpmRoot(params.npmRoot)) {
    return { repaired: 0 };
  }
  let repaired = 0;
  for (const packageDir of await listManagedNpmRootPackageDirs(params.npmRoot)) {
    const openClawLinkDependencies = await readPackageOpenClawLinkDependencies(
      packageDir,
      params.onPackageReadError,
    );
    if (!openClawLinkDependencies) {
      continue;
    }
    const result = await linkOpenClawPeerDependencies({
      installedDir: packageDir,
      peerDependencies: openClawLinkDependencies,
      logger: params.logger,
      beforePersistentApply: params.beforePersistentApply,
      beforePersistentEffect: params.beforePersistentEffect,
    });
    repaired += result.repaired;
  }
  return { repaired };
}

export async function auditOpenClawPeerDependenciesInManagedNpmRoot(params: {
  npmRoot: string;
  onPackageReadError?: (error: unknown, packageDir: string) => void;
}): Promise<AuditManagedNpmRootResult> {
  const hostRoot = resolveOpenClawHostRoot();
  if (!hostRoot) {
    return { issues: [] };
  }

  const issues: OpenClawPeerLinkAuditIssue[] = [];
  for (const packageDir of await listManagedNpmRootPackageDirs(params.npmRoot)) {
    const openClawLinkDependencies = await readPackageOpenClawLinkDependencies(
      packageDir,
      params.onPackageReadError,
    );
    if (!openClawLinkDependencies) {
      continue;
    }
    const issue = auditOpenClawPeerDependency({
      hostRoot,
      npmRoot: params.npmRoot,
      packageDir,
    });
    if (issue) {
      issues.push(issue);
    }
  }
  return { issues };
}
