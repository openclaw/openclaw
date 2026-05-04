import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { saveJsonFile } from "../infra/json-file.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveDefaultPluginNpmDir } from "../plugins/install-paths.js";
import type { InstalledPluginIndexRecordStoreOptions } from "../plugins/installed-plugin-index-records.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { refreshPluginRegistry } from "../plugins/plugin-registry.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV,
  migratePluginRegistryForInstall,
  preflightPluginRegistryInstallMigration,
  type PluginRegistryInstallMigrationParams,
} from "./doctor/shared/plugin-registry-migration.js";

type PluginRegistryDoctorRepairParams = Omit<PluginRegistryInstallMigrationParams, "config"> &
  InstalledPluginIndexRecordStoreOptions & {
    config: OpenClawConfig;
    prompter: Pick<DoctorPrompter, "shouldRepair">;
  };

type StaleManagedNpmBundledPlugin = {
  pluginId: string;
  packageName: string;
  packageDir: string;
  npmRoot: string;
  version?: string;
};

type ManagedNpmOpenClawPeerLink = {
  pluginId?: string;
  packageName: string;
  packageDir: string;
  linkPath: string;
  expectedTarget: string;
  currentTarget?: string;
};

type ManagedNpmOpenClawPeerLinkScan = {
  links: ManagedNpmOpenClawPeerLink[];
  warnings: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" && raw.trim()) {
      result[key] = raw.trim();
    }
  }
  return result;
}

function resolveManagedPluginNpmRoot(params: PluginRegistryDoctorRepairParams): string {
  return params.stateDir
    ? path.join(params.stateDir, "npm")
    : resolveDefaultPluginNpmDir(params.env);
}

function deleteObjectKey(record: Record<string, unknown>, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return false;
  }
  delete record[key];
  return true;
}

function readPackageVersion(packageDir: string): string | undefined {
  const packageJson = readJsonObject(path.join(packageDir, "package.json"));
  const version = packageJson?.version;
  return typeof version === "string" && version.trim() ? version.trim() : undefined;
}

function readPluginManifestId(packageDir: string): string | undefined {
  const manifest = readJsonObject(path.join(packageDir, "openclaw.plugin.json"));
  const id = manifest?.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function readPackagePeerDependencies(packageDir: string): Record<string, string> {
  return readStringMap(readJsonObject(path.join(packageDir, "package.json"))?.peerDependencies);
}

function listStaleManagedNpmBundledPlugins(
  params: PluginRegistryDoctorRepairParams,
): StaleManagedNpmBundledPlugin[] {
  const currentBundled = loadInstalledPluginIndex({
    ...params,
    installRecords: {},
  }).plugins.filter((plugin) => plugin.origin === "bundled" && plugin.packageName);
  const bundledByPackage = new Map(
    currentBundled.map((plugin) => [plugin.packageName, plugin] as const),
  );
  const npmRoot = resolveManagedPluginNpmRoot(params);
  const npmPackageJsonPath = path.join(npmRoot, "package.json");
  const dependencies = readStringMap(readJsonObject(npmPackageJsonPath)?.dependencies);
  const stale: StaleManagedNpmBundledPlugin[] = [];

  for (const packageName of Object.keys(dependencies).toSorted()) {
    if (!packageName.startsWith("@openclaw/")) {
      continue;
    }
    const bundled = bundledByPackage.get(packageName);
    if (!bundled) {
      continue;
    }
    const packageDir = path.join(npmRoot, "node_modules", packageName);
    const pluginId = readPluginManifestId(packageDir);
    if (!pluginId || pluginId !== bundled.pluginId) {
      continue;
    }
    stale.push({
      pluginId,
      packageName,
      packageDir,
      npmRoot,
      ...(readPackageVersion(packageDir) ? { version: readPackageVersion(packageDir) } : {}),
    });
  }

  return stale;
}

function removeManagedNpmDependency(params: {
  npmRoot: string;
  packageName: string;
  packageDir: string;
}): void {
  const npmPackageJsonPath = path.join(params.npmRoot, "package.json");
  const packageJson = readJsonObject(npmPackageJsonPath) ?? {};
  const dependencies = readStringMap(packageJson.dependencies);
  delete dependencies[params.packageName];
  const nextPackageJson =
    Object.keys(dependencies).length === 0
      ? (() => {
          const { dependencies: _dependencies, ...rest } = packageJson;
          return rest;
        })()
      : {
          ...packageJson,
          dependencies,
        };
  saveJsonFile(npmPackageJsonPath, nextPackageJson);
  removeManagedNpmPackageLockDependency(params);
  fs.rmSync(params.packageDir, { recursive: true, force: true });
  const scopeDir = path.dirname(params.packageDir);
  if (path.basename(path.dirname(scopeDir)) === "node_modules") {
    try {
      fs.rmdirSync(scopeDir);
    } catch {
      // Other packages can still live under the scope directory.
    }
  }
}

function removeManagedNpmPackageLockDependency(params: {
  npmRoot: string;
  packageName: string;
}): void {
  const packageLockPath = path.join(params.npmRoot, "package-lock.json");
  const packageLock = readJsonObject(packageLockPath);
  if (!packageLock) {
    return;
  }

  let changed = false;
  const packages = packageLock.packages;
  if (isRecord(packages)) {
    const rootPackage = packages[""];
    if (isRecord(rootPackage)) {
      const rootDependencies = readStringMap(rootPackage.dependencies);
      if (deleteObjectKey(rootDependencies, params.packageName)) {
        changed = true;
        if (Object.keys(rootDependencies).length === 0) {
          delete rootPackage.dependencies;
        } else {
          rootPackage.dependencies = rootDependencies;
        }
      }
    }
    changed = deleteObjectKey(packages, `node_modules/${params.packageName}`) || changed;
  }

  const dependencies = packageLock.dependencies;
  if (isRecord(dependencies)) {
    changed = deleteObjectKey(dependencies, params.packageName) || changed;
  }

  if (changed) {
    saveJsonFile(packageLockPath, packageLock);
  }
}

export function maybeRepairStaleManagedNpmBundledPlugins(
  params: PluginRegistryDoctorRepairParams,
): boolean {
  const stale = listStaleManagedNpmBundledPlugins(params);
  if (stale.length === 0) {
    return false;
  }

  if (!params.prompter.shouldRepair) {
    note(
      [
        "Managed npm plugin packages shadow bundled plugins:",
        ...stale.map(
          (plugin) =>
            `- ${plugin.pluginId}: ${plugin.packageName}${plugin.version ? `@${plugin.version}` : ""}`,
        ),
        `Repair with ${formatCliCommand("openclaw doctor --fix")} to remove stale managed npm packages and rebuild the plugin registry.`,
      ].join("\n"),
      "Plugin registry",
    );
    return false;
  }

  for (const plugin of stale) {
    removeManagedNpmDependency(plugin);
  }
  note(
    [
      "Removed stale managed npm plugin package(s) shadowing bundled plugins:",
      ...stale.map(
        (plugin) =>
          `- ${plugin.pluginId}: ${plugin.packageName}${plugin.version ? `@${plugin.version}` : ""}`,
      ),
    ].join("\n"),
    "Plugin registry",
  );
  return true;
}

function safeRealpath(filePath: string): string | undefined {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return undefined;
  }
}

function safeReadlink(filePath: string): string | undefined {
  try {
    return fs.readlinkSync(filePath);
  } catch {
    return undefined;
  }
}

function resolveManagedNpmDependencyPackageDir(params: {
  npmRoot: string;
  packageName: string;
}): string {
  return path.join(params.npmRoot, "node_modules", params.packageName);
}

function formatManagedNpmOpenClawPeerLink(link: ManagedNpmOpenClawPeerLink): string {
  return link.pluginId && link.pluginId !== link.packageName
    ? `${link.pluginId}: ${link.packageName}`
    : link.packageName;
}

function resolveManagedNpmDependencyPackageDirInsideRoot(params: {
  npmRoot: string;
  packageName: string;
}): { packageDir: string } | { warning: string } {
  const nodeModulesRoot = path.join(params.npmRoot, "node_modules");
  const packageDir = resolveManagedNpmDependencyPackageDir(params);
  if (!isPathInside(nodeModulesRoot, packageDir)) {
    return {
      warning: `- ${params.packageName}: package path escapes the managed npm root; skipping peer-link repair.`,
    };
  }

  const packageDirRealpath = safeRealpath(packageDir);
  if (packageDirRealpath && !isPathInside(nodeModulesRoot, packageDirRealpath)) {
    return {
      warning: `- ${params.packageName}: package path resolves outside the managed npm root; skipping peer-link repair.`,
    };
  }

  return { packageDir };
}

function listManagedNpmOpenClawPeerLinks(
  params: PluginRegistryDoctorRepairParams,
): ManagedNpmOpenClawPeerLinkScan {
  const npmRoot = resolveManagedPluginNpmRoot(params);
  const dependencies = readStringMap(
    readJsonObject(path.join(npmRoot, "package.json"))?.dependencies,
  );
  if (Object.keys(dependencies).length === 0) {
    return { links: [], warnings: [] };
  }

  const hostRoot = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
    cwd: process.cwd(),
  });
  if (!hostRoot) {
    return {
      links: [],
      warnings: [
        "Could not locate the OpenClaw package root to repair managed npm plugin peer links; plugin SDK imports may still fail.",
      ],
    };
  }

  const expectedTarget = safeRealpath(hostRoot) ?? hostRoot;
  const links: ManagedNpmOpenClawPeerLink[] = [];
  const warnings: string[] = [];
  for (const packageName of Object.keys(dependencies).toSorted()) {
    const packageDirResult = resolveManagedNpmDependencyPackageDirInsideRoot({
      npmRoot,
      packageName,
    });
    if ("warning" in packageDirResult) {
      warnings.push(packageDirResult.warning);
      continue;
    }
    const { packageDir } = packageDirResult;
    const peerDependencies = readPackagePeerDependencies(packageDir);
    if (!Object.prototype.hasOwnProperty.call(peerDependencies, "openclaw")) {
      continue;
    }
    const linkPath = path.join(packageDir, "node_modules", "openclaw");
    if (!isPathInside(packageDir, linkPath)) {
      warnings.push(
        `- ${packageName}: peer-link path escapes the package directory; skipping peer-link repair.`,
      );
      continue;
    }
    const currentTarget = safeRealpath(linkPath) ?? safeReadlink(linkPath);
    if (currentTarget === expectedTarget) {
      continue;
    }
    const pluginId = readPluginManifestId(packageDir);
    links.push({
      ...(pluginId ? { pluginId } : {}),
      packageName,
      packageDir,
      linkPath,
      expectedTarget,
      ...(currentTarget ? { currentTarget } : {}),
    });
  }
  return { links, warnings };
}

function repairManagedNpmOpenClawPeerLink(link: ManagedNpmOpenClawPeerLink): void {
  fs.mkdirSync(path.dirname(link.linkPath), { recursive: true });
  fs.rmSync(link.linkPath, { recursive: true, force: true });
  fs.symlinkSync(link.expectedTarget, link.linkPath, "junction");
}

export function maybeRepairManagedNpmOpenClawPeerLinks(
  params: PluginRegistryDoctorRepairParams,
): boolean {
  const { links: missingOrStaleLinks, warnings: scanWarnings } =
    listManagedNpmOpenClawPeerLinks(params);
  if (scanWarnings.length > 0) {
    note(
      ["Could not inspect all managed npm OpenClaw host peer links:", ...scanWarnings].join("\n"),
      "Plugin registry",
    );
  }
  if (missingOrStaleLinks.length === 0) {
    return false;
  }

  if (!params.prompter.shouldRepair) {
    note(
      [
        "Managed npm plugin packages are missing their OpenClaw host peer link:",
        ...missingOrStaleLinks.map((link) => `- ${formatManagedNpmOpenClawPeerLink(link)}`),
        `Repair with ${formatCliCommand("openclaw doctor --fix")} to relink the host openclaw package for plugin SDK imports.`,
      ].join("\n"),
      "Plugin registry",
    );
    return false;
  }

  const repaired: ManagedNpmOpenClawPeerLink[] = [];
  const warnings: string[] = [];
  for (const link of missingOrStaleLinks) {
    try {
      repairManagedNpmOpenClawPeerLink(link);
      repaired.push(link);
    } catch (error) {
      warnings.push(`- ${formatManagedNpmOpenClawPeerLink(link)}: ${String(error)}`);
    }
  }

  if (repaired.length > 0) {
    note(
      [
        "Repaired OpenClaw host peer link(s) for managed npm plugins:",
        ...repaired.map((link) => `- ${formatManagedNpmOpenClawPeerLink(link)}`),
      ].join("\n"),
      "Plugin registry",
    );
  }
  if (warnings.length > 0) {
    note(
      ["Could not repair OpenClaw host peer link(s) for managed npm plugins:", ...warnings].join(
        "\n",
      ),
      "Plugin registry",
    );
  }
  return repaired.length > 0;
}

export async function maybeRepairPluginRegistryState(
  params: PluginRegistryDoctorRepairParams,
): Promise<OpenClawConfig> {
  const preflight = preflightPluginRegistryInstallMigration(params);
  for (const warning of preflight.deprecationWarnings) {
    note(warning, "Plugin registry");
  }
  if (preflight.action === "disabled") {
    note(
      `${DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV} is set; skipping plugin registry repair.`,
      "Plugin registry",
    );
    return params.config;
  }

  const migrationParams = {
    ...params,
    config: params.config,
  };
  const removedStaleManagedNpmBundledPlugins = maybeRepairStaleManagedNpmBundledPlugins(params);
  const repairedManagedNpmOpenClawPeerLinks = maybeRepairManagedNpmOpenClawPeerLinks(params);
  if (!params.prompter.shouldRepair) {
    if (preflight.action === "migrate") {
      note(
        [
          "Persisted plugin registry is missing or stale.",
          `Repair with ${formatCliCommand("openclaw doctor --fix")} to rebuild ${shortenHomePath(preflight.filePath)} from enabled plugins.`,
        ].join("\n"),
        "Plugin registry",
      );
    }
    return params.config;
  }

  if (preflight.action === "migrate") {
    const result = await migratePluginRegistryForInstall(migrationParams);
    if (result.migrated) {
      const total = result.current.plugins.length;
      const enabled = result.current.plugins.filter((plugin) => plugin.enabled).length;
      note(
        `Plugin registry rebuilt: ${enabled}/${total} enabled plugins indexed.`,
        "Plugin registry",
      );
    }
    return params.config;
  }

  if (
    preflight.action === "skip-existing" ||
    removedStaleManagedNpmBundledPlugins ||
    repairedManagedNpmOpenClawPeerLinks
  ) {
    const index = await refreshPluginRegistry({
      ...migrationParams,
      reason: "migration",
    });
    const total = index.plugins.length;
    const enabled = index.plugins.filter((plugin) => plugin.enabled).length;
    note(
      `Plugin registry refreshed: ${enabled}/${total} enabled plugins indexed.`,
      "Plugin registry",
    );
  }

  return params.config;
}
