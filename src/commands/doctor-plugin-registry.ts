import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { saveJsonFile } from "../infra/json-file.js";
import { tryReadJsonSync } from "../infra/json-files.js";
import type { BundledPluginSource } from "../plugins/bundled-sources.js";
import { resolveDefaultPluginNpmDir } from "../plugins/install-paths.js";
import {
  loadInstalledPluginIndexInstallRecords,
  type InstalledPluginIndexRecordStoreOptions,
} from "../plugins/installed-plugin-index-records.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import {
  auditOpenClawPeerDependenciesInManagedNpmRoot,
  relinkOpenClawPeerDependenciesInManagedNpmRoot,
} from "../plugins/plugin-peer-link.js";
import { refreshPluginRegistry } from "../plugins/plugin-registry.js";
import {
  listStaleLocalBundledPluginInstallRecords,
  type StaleLocalBundledPluginInstallRecord,
} from "../plugins/stale-local-bundled-plugin-install-records.js";
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

type PluginRegistryDoctorNoteLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  const parsed = tryReadJsonSync(filePath);
  return isRecord(parsed) ? parsed : null;
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

export type PluginRegistryStateIssue =
  | {
      kind: "migration";
      filePath: string;
      action: "migrate";
    }
  | {
      kind: "disabled";
      reason: string;
    }
  | {
      kind: "stale-managed-npm-bundled-plugin";
      pluginId: string;
      packageName: string;
      packageDir: string;
      version?: string;
    }
  | {
      kind: "stale-local-bundled-plugin-install-record";
      pluginId: string;
      stalePath: string;
    }
  | {
      kind: "managed-npm-peer-link";
      packageName: string;
      reason: string;
    };

export function resolveManagedPluginNpmRoot(params: PluginRegistryDoctorRepairParams): string {
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

export function listStaleManagedNpmBundledPlugins(
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

  for (const packageName of Object.keys(dependencies).toSorted((left, right) =>
    left.localeCompare(right),
  )) {
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

function loadCurrentBundledPluginSources(
  params: PluginRegistryDoctorRepairParams,
): Map<string, BundledPluginSource> {
  const currentBundled = loadInstalledPluginIndex({
    ...params,
    installRecords: {},
  }).plugins.filter((plugin) => plugin.origin === "bundled");
  return new Map(
    currentBundled.map(
      (plugin) =>
        [
          plugin.pluginId,
          {
            pluginId: plugin.pluginId,
            localPath: plugin.rootDir,
            ...(plugin.packageName ? { npmSpec: plugin.packageName } : {}),
            ...(plugin.packageVersion ? { version: plugin.packageVersion } : {}),
          },
        ] as const,
    ),
  );
}

async function listStaleLocalBundledPluginInstallRecordShadows(
  params: PluginRegistryDoctorRepairParams,
): Promise<StaleLocalBundledPluginInstallRecord[]> {
  return listStaleLocalBundledPluginInstallRecords({
    installRecords: await loadInstalledPluginIndexInstallRecords(params),
    workspaceDir: params.workspaceDir,
    env: params.env,
    bundled: loadCurrentBundledPluginSources(params),
  });
}

export async function detectPluginRegistryStateIssues(
  params: PluginRegistryDoctorRepairParams,
): Promise<PluginRegistryStateIssue[]> {
  const preflight = preflightPluginRegistryInstallMigration(params);
  if (preflight.action === "disabled") {
    return [
      {
        kind: "disabled",
        reason: `${DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV} is set; skipping plugin registry repair.`,
      },
    ];
  }
  const issues: PluginRegistryStateIssue[] = [];
  if (preflight.action === "migrate") {
    issues.push({
      kind: "migration",
      action: "migrate",
      filePath: preflight.filePath,
    });
  }
  for (const plugin of listStaleManagedNpmBundledPlugins(params)) {
    issues.push({
      kind: "stale-managed-npm-bundled-plugin",
      pluginId: plugin.pluginId,
      packageName: plugin.packageName,
      packageDir: plugin.packageDir,
      ...(plugin.version ? { version: plugin.version } : {}),
    });
  }
  for (const record of await listStaleLocalBundledPluginInstallRecordShadows(params)) {
    issues.push({
      kind: "stale-local-bundled-plugin-install-record",
      pluginId: record.pluginId,
      stalePath: record.stalePath,
    });
  }
  const peerAudit = await auditOpenClawPeerDependenciesInManagedNpmRoot({
    npmRoot: resolveManagedPluginNpmRoot(params),
  });
  for (const issue of peerAudit.issues) {
    issues.push({
      kind: "managed-npm-peer-link",
      packageName: issue.packageName,
      reason: issue.reason,
    });
  }
  return issues;
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

export async function maybeRepairStaleLocalBundledPluginInstallRecords(
  params: PluginRegistryDoctorRepairParams,
): Promise<string[]> {
  const stale = await listStaleLocalBundledPluginInstallRecordShadows(params);
  if (stale.length === 0) {
    return [];
  }

  if (!params.prompter.shouldRepair) {
    note(
      [
        "Local bundled plugin install records shadow bundled plugins:",
        ...stale.map((record) => `- ${record.pluginId}: ${shortenHomePath(record.stalePath)}`),
        `Repair with ${formatCliCommand("openclaw doctor --fix")} to remove stale local install records and rebuild the plugin registry.`,
      ].join("\n"),
      "Plugin registry",
    );
    return [];
  }

  note(
    [
      "Removed stale local bundled plugin install record(s) shadowing bundled plugins:",
      ...stale.map((record) => `- ${record.pluginId}: ${shortenHomePath(record.stalePath)}`),
    ].join("\n"),
    "Plugin registry",
  );
  return stale.map((record) => record.pluginId);
}

export async function maybeRepairManagedNpmOpenClawPeerLinks(
  params: PluginRegistryDoctorRepairParams,
): Promise<boolean> {
  const npmRoot = resolveManagedPluginNpmRoot(params);
  if (!params.prompter.shouldRepair) {
    const audit = await auditOpenClawPeerDependenciesInManagedNpmRoot({ npmRoot });
    if (audit.broken > 0) {
      note(
        [
          "Managed npm OpenClaw host peer links need repair:",
          ...audit.issues.map((issue) => `- ${issue.packageName}: ${issue.reason}`),
          `Repair with ${formatCliCommand("openclaw doctor --fix")} to relink managed npm plugin packages.`,
        ].join("\n"),
        "Plugin registry",
      );
    }
    return false;
  }

  const messages: { level: "info" | "warn"; message: string }[] = [];
  const logger: PluginRegistryDoctorNoteLogger = {
    info: (message) => messages.push({ level: "info", message }),
    warn: (message) => messages.push({ level: "warn", message }),
  };
  const result = await relinkOpenClawPeerDependenciesInManagedNpmRoot({
    npmRoot,
    logger,
  });

  if (result.repaired > 0) {
    note(
      `Repaired OpenClaw host peer link(s) for ${result.repaired} managed npm plugin package(s).`,
      "Plugin registry",
    );
  }
  const warnings = messages
    .filter((message) => message.level === "warn")
    .map((message) => `- ${message.message}`);
  if (warnings.length > 0) {
    note(
      ["Could not repair all managed npm OpenClaw host peer links:", ...warnings].join("\n"),
      "Plugin registry",
    );
  }

  return result.repaired > 0;
}

async function loadInstallRecordsWithoutPluginIds(
  params: PluginRegistryDoctorRepairParams,
  pluginIds: readonly string[],
) {
  const records = await loadInstalledPluginIndexInstallRecords(params);
  for (const pluginId of pluginIds) {
    delete records[pluginId];
  }
  return records;
}

export type PluginRegistryStateRepairResult = {
  status?: "repaired" | "skipped" | "failed";
  reason?: string;
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
};

function staleManagedNpmPluginLine(plugin: StaleManagedNpmBundledPlugin): string {
  return `${plugin.pluginId}: ${plugin.packageName}${plugin.version ? `@${plugin.version}` : ""}`;
}

function shouldRepairPluginRegistryMigration(
  issues: readonly PluginRegistryStateIssue[] | undefined,
): boolean {
  return issues === undefined || issues.some((issue) => issue.kind === "migration");
}

function shouldRepairManagedNpmPeerLinks(
  issues: readonly PluginRegistryStateIssue[] | undefined,
): boolean {
  return issues === undefined || issues.some((issue) => issue.kind === "managed-npm-peer-link");
}

function filterStaleManagedNpmBundledPluginsForIssues(
  plugins: readonly StaleManagedNpmBundledPlugin[],
  issues: readonly PluginRegistryStateIssue[] | undefined,
): StaleManagedNpmBundledPlugin[] {
  if (issues === undefined) {
    return [...plugins];
  }
  const selected = issues.filter((issue) => issue.kind === "stale-managed-npm-bundled-plugin");
  if (selected.length === 0) {
    return [];
  }
  return plugins.filter((plugin) =>
    selected.some(
      (issue) =>
        issue.pluginId === plugin.pluginId ||
        issue.packageName === plugin.packageName ||
        issue.packageDir === plugin.packageDir,
    ),
  );
}

function filterStaleLocalBundledPluginInstallRecordsForIssues(
  records: readonly StaleLocalBundledPluginInstallRecord[],
  issues: readonly PluginRegistryStateIssue[] | undefined,
): StaleLocalBundledPluginInstallRecord[] {
  if (issues === undefined) {
    return [...records];
  }
  const selected = issues.filter(
    (issue) => issue.kind === "stale-local-bundled-plugin-install-record",
  );
  if (selected.length === 0) {
    return [];
  }
  return records.filter((record) =>
    selected.some(
      (issue) => issue.pluginId === record.pluginId || issue.stalePath === record.stalePath,
    ),
  );
}

export async function repairPluginRegistryState(
  params: PluginRegistryDoctorRepairParams,
  issues?: readonly PluginRegistryStateIssue[],
): Promise<PluginRegistryStateRepairResult> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const preflight = preflightPluginRegistryInstallMigration(params);
  warnings.push(...preflight.deprecationWarnings);
  if (preflight.action === "disabled") {
    const reason = `${DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV} is set; skipping plugin registry repair.`;
    warnings.push(reason);
    return { status: "skipped", reason, config: params.config, changes, warnings };
  }

  if (!params.prompter.shouldRepair) {
    return { config: params.config, changes, warnings };
  }

  const staleManagedNpmBundledPlugins = filterStaleManagedNpmBundledPluginsForIssues(
    listStaleManagedNpmBundledPlugins(params),
    issues,
  );
  for (const plugin of staleManagedNpmBundledPlugins) {
    removeManagedNpmDependency(plugin);
  }
  if (staleManagedNpmBundledPlugins.length > 0) {
    changes.push(
      [
        "Removed stale managed npm plugin package(s) shadowing bundled plugins:",
        ...staleManagedNpmBundledPlugins.map((plugin) => `- ${staleManagedNpmPluginLine(plugin)}`),
      ].join("\n"),
    );
  }
  const staleLocalBundledPluginInstallRecords =
    filterStaleLocalBundledPluginInstallRecordsForIssues(
      await listStaleLocalBundledPluginInstallRecordShadows(params),
      issues,
    );
  if (staleLocalBundledPluginInstallRecords.length > 0) {
    changes.push(
      [
        "Removed stale local bundled plugin install record(s) shadowing bundled plugins:",
        ...staleLocalBundledPluginInstallRecords.map(
          (record) => `- ${record.pluginId}: ${shortenHomePath(record.stalePath)}`,
        ),
      ].join("\n"),
    );
  }

  const messages: { level: "info" | "warn"; message: string }[] = [];
  const result = shouldRepairManagedNpmPeerLinks(issues)
    ? await relinkOpenClawPeerDependenciesInManagedNpmRoot({
        npmRoot: resolveManagedPluginNpmRoot(params),
        logger: {
          info: (message) => messages.push({ level: "info", message }),
          warn: (message) => messages.push({ level: "warn", message }),
        },
      })
    : { repaired: 0 };
  if (result.repaired > 0) {
    changes.push(
      `Repaired OpenClaw host peer link(s) for ${result.repaired} managed npm plugin package(s).`,
    );
  }
  const peerWarnings = messages
    .filter((message) => message.level === "warn")
    .map((message) => `- ${message.message}`);
  if (peerWarnings.length > 0) {
    warnings.push(
      ["Could not repair all managed npm OpenClaw host peer links:", ...peerWarnings].join("\n"),
    );
  }

  const migrationParams = {
    ...params,
    config: params.config,
  };
  const stalePluginIdsToRemove = [
    ...new Set([
      ...staleManagedNpmBundledPlugins.map((plugin) => plugin.pluginId),
      ...staleLocalBundledPluginInstallRecords.map((record) => record.pluginId),
    ]),
  ];
  if (preflight.action === "migrate" && shouldRepairPluginRegistryMigration(issues)) {
    const migrated = await migratePluginRegistryForInstall({
      ...migrationParams,
      ...(stalePluginIdsToRemove.length > 0
        ? {
            installRecords: await loadInstallRecordsWithoutPluginIds(
              params,
              stalePluginIdsToRemove,
            ),
          }
        : {}),
    });
    if (migrated.migrated) {
      const total = migrated.current.plugins.length;
      const enabled = migrated.current.plugins.filter((plugin) => plugin.enabled).length;
      changes.push(`Plugin registry rebuilt: ${enabled}/${total} enabled plugins indexed.`);
    }
    return { config: params.config, changes, warnings };
  }

  if (
    preflight.action === "skip-existing" ||
    staleManagedNpmBundledPlugins.length > 0 ||
    staleLocalBundledPluginInstallRecords.length > 0 ||
    result.repaired > 0
  ) {
    const index = await refreshPluginRegistry({
      ...migrationParams,
      reason: "migration",
      ...(stalePluginIdsToRemove.length > 0
        ? {
            installRecords: await loadInstallRecordsWithoutPluginIds(
              params,
              stalePluginIdsToRemove,
            ),
          }
        : {}),
    });
    const total = index.plugins.length;
    const enabled = index.plugins.filter((plugin) => plugin.enabled).length;
    changes.push(`Plugin registry refreshed: ${enabled}/${total} enabled plugins indexed.`);
  }

  return { config: params.config, changes, warnings };
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
  const staleManagedNpmBundledPluginIds = listStaleManagedNpmBundledPlugins(params).map(
    (plugin) => plugin.pluginId,
  );
  const removedStaleManagedNpmBundledPlugins = maybeRepairStaleManagedNpmBundledPlugins(params);
  const removedStaleLocalBundledPluginIds =
    await maybeRepairStaleLocalBundledPluginInstallRecords(params);
  const repairedManagedNpmOpenClawPeerLinks = await maybeRepairManagedNpmOpenClawPeerLinks(params);
  const stalePluginIdsToRemove = [
    ...new Set([
      ...(removedStaleManagedNpmBundledPlugins ? staleManagedNpmBundledPluginIds : []),
      ...removedStaleLocalBundledPluginIds,
    ]),
  ];
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
    const result = await migratePluginRegistryForInstall({
      ...migrationParams,
      ...(stalePluginIdsToRemove.length > 0
        ? {
            installRecords: await loadInstallRecordsWithoutPluginIds(
              params,
              stalePluginIdsToRemove,
            ),
          }
        : {}),
    });
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
    removedStaleLocalBundledPluginIds.length > 0 ||
    repairedManagedNpmOpenClawPeerLinks
  ) {
    const index = await refreshPluginRegistry({
      ...migrationParams,
      reason: "migration",
      ...(stalePluginIdsToRemove.length > 0
        ? {
            installRecords: await loadInstallRecordsWithoutPluginIds(
              params,
              stalePluginIdsToRemove,
            ),
          }
        : {}),
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
