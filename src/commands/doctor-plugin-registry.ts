/** Doctor repairs for stale plugin registry entries, managed npm shadows, and peer links. */
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { writeJsonTarget } from "../infra/json-file.js";
import { tryReadJsonSync } from "../infra/json-files.js";
import type { BundledPluginSource } from "../plugins/bundled-sources.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
  removePluginInstallRecordFromRecords,
  type InstalledPluginIndexRecordStoreOptions,
} from "../plugins/installed-plugin-index-records.js";
import { resolveInstalledPluginIndexStateDatabaseOptions } from "../plugins/installed-plugin-index-store-path.js";
import {
  loadInstalledPluginIndex,
  type InstalledPluginIndex,
} from "../plugins/installed-plugin-index.js";
import { hasRetainedManagedNpmInstallMarker } from "../plugins/managed-npm-retention.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import { isExternallyDistributedPlugin } from "../plugins/official-external-plugin-catalog.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import type { OpenClawPeerLinkAuditIssue } from "../plugins/plugin-peer-link.js";
import { refreshPluginRegistry } from "../plugins/plugin-registry-refresh.js";
import {
  listStaleLocalBundledPluginInstallRecords,
  type StaleLocalBundledPluginInstallRecord,
} from "../plugins/stale-local-bundled-plugin-install-records.js";
import { shortenHomePath } from "../utils.js";
import {
  listStaleManagedNpmInstallGenerations,
  maybeRepairStaleManagedNpmInstallGenerations,
  PLUGIN_REGISTRY_CHECK_ID,
  staleManagedNpmInstallGenerationToHealthFinding,
  staleManagedNpmInstallGenerationToRepairEffect,
  type StaleManagedNpmInstallGenerationIssue,
} from "./doctor-plugin-generations.js";
import {
  resolveDoctorPluginNpmRoots,
  listPluginOpenClawHostLinkIssues,
  maybeRepairPluginOpenClawHostLinks,
} from "./doctor-plugin-host-links.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  InvalidPluginInstallRecordStateError,
  migrateOfficialPluginInstallProvenance,
  migratePluginRegistryForDoctor,
  preflightPluginRegistryDoctorMigration,
  type PluginRegistryDoctorMigrationParams,
} from "./doctor/shared/plugin-registry-migration.js";

type PluginRegistryDoctorRepairParams = Omit<PluginRegistryDoctorMigrationParams, "config"> &
  InstalledPluginIndexRecordStoreOptions & {
    config: OpenClawConfig;
    prompter: Pick<DoctorPrompter, "shouldRepair">;
  };

type PluginRegistryDoctorRepairResult = {
  config: OpenClawConfig;
  pluginInventoryChanged?: true;
};

type StaleManagedNpmBundledPlugin = {
  pluginId: string;
  packageName: string;
  packageDir: string;
  npmRoot: string;
  version?: string;
};

type PluginRegistryHealthIssue =
  | {
      kind: "registry-missing-or-stale";
      path: string;
    }
  | ({ kind: "stale-managed-npm-bundled-plugin" } & StaleManagedNpmBundledPlugin)
  | {
      kind: "stale-local-bundled-plugin-install-record";
      pluginId: string;
      stalePath: string;
    }
  | ({
      kind: "managed-npm-openclaw-peer-link" | "registered-npm-openclaw-host-link";
    } & OpenClawPeerLinkAuditIssue)
  | {
      kind: "managed-npm-package-unreadable" | "registered-npm-package-unreadable";
      packageDir: string;
      reason: string;
    }
  | StaleManagedNpmInstallGenerationIssue;

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

function deleteObjectKey(record: Record<string, unknown>, key: string): boolean {
  if (!Object.hasOwn(record, key)) {
    return false;
  }
  delete record[key];
  return true;
}

function listStaleManagedNpmBundledPlugins(
  params: PluginRegistryDoctorRepairParams,
): StaleManagedNpmBundledPlugin[] {
  const currentBundled = loadInstalledPluginIndex({
    ...params,
    installRecords: {},
  }).plugins.filter(
    (plugin) => plugin.origin === "bundled" && !isExternallyDistributedPlugin(plugin),
  );
  const bundledByPackage = new Map(
    currentBundled.map((plugin) => [plugin.packageName, plugin] as const),
  );
  const stale: StaleManagedNpmBundledPlugin[] = [];

  for (const npmRoot of resolveDoctorPluginNpmRoots(params)) {
    const npmPackageJsonPath = path.join(npmRoot, "package.json");
    const dependencies = readStringMap(readJsonObject(npmPackageJsonPath)?.dependencies);
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
      const packageDir = path.join(npmRoot, "node_modules", ...packageName.split("/"));
      if (hasRetainedManagedNpmInstallMarker(packageDir)) {
        continue;
      }
      const pluginId = normalizeOptionalString(
        readJsonObject(path.join(packageDir, "openclaw.plugin.json"))?.id,
      );
      if (!pluginId || pluginId !== bundled.pluginId) {
        continue;
      }
      const version = normalizeOptionalString(
        readJsonObject(path.join(packageDir, "package.json"))?.version,
      );
      stale.push({
        pluginId,
        packageName,
        packageDir,
        npmRoot,
        ...(version ? { version } : {}),
      });
    }
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

function removeManagedNpmDependency(params: {
  npmRoot: string;
  packageName: string;
  packageDir: string;
}): void {
  const npmPackageJsonPath = path.join(params.npmRoot, "package.json");
  const packageJson = readJsonObject(npmPackageJsonPath) ?? {};
  const dependencies = readStringMap(packageJson.dependencies);
  delete dependencies[params.packageName];
  if (Object.keys(dependencies).length === 0) {
    delete packageJson.dependencies;
  } else {
    packageJson.dependencies = dependencies;
  }
  writeJsonTarget(npmPackageJsonPath, packageJson);
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
    writeJsonTarget(packageLockPath, packageLock);
  }
}

/** Removes managed npm packages that shadow current bundled plugins when repair is enabled. */
export function maybeRepairStaleManagedNpmBundledPlugins(
  params: PluginRegistryDoctorRepairParams & {
    installRecords?: Record<string, PluginInstallRecord>;
  },
) {
  const stale = listStaleManagedNpmBundledPlugins(params);
  if (stale.length === 0) {
    return null;
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
    return null;
  }

  // Capture one authoritative record baseline before deleting the payload. Later readers recover
  // managed records from disk, so package-only cleanup can otherwise resurrect the same install.
  let installRecords = params.installRecords ?? loadInstalledPluginIndexInstallRecordsSync(params);
  const removedPluginIds = [...new Set(stale.map((plugin) => plugin.pluginId))].toSorted(
    (left, right) => left.localeCompare(right),
  );
  for (const pluginId of removedPluginIds) {
    installRecords = removePluginInstallRecordFromRecords(installRecords, pluginId);
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
  return { installRecords, removedPluginIds };
}

/** Removes local install records that shadow current bundled plugin sources. */
async function maybeRepairStaleLocalBundledPluginInstallRecords(
  params: PluginRegistryDoctorRepairParams,
): Promise<string[]> {
  const stale = await listStaleLocalBundledPluginInstallRecordShadows(params);
  if (stale.length === 0) {
    return [];
  }

  const shouldRepair = params.prompter.shouldRepair;
  note(
    [
      shouldRepair
        ? "Removed stale local bundled plugin install record(s) shadowing bundled plugins:"
        : "Local bundled plugin install records shadow bundled plugins:",
      ...stale.map((record) => `- ${record.pluginId}: ${shortenHomePath(record.stalePath)}`),
      ...(!shouldRepair
        ? [
            `Repair with ${formatCliCommand("openclaw doctor --fix")} to remove stale local install records and rebuild the plugin registry.`,
          ]
        : []),
    ].join("\n"),
    "Plugin registry",
  );
  return shouldRepair ? stale.map((record) => record.pluginId) : [];
}

async function loadRepairedPluginInstallRecords(
  params: PluginRegistryDoctorRepairParams,
  pluginIds: readonly string[],
  baselineRecords?: Record<string, PluginInstallRecord>,
) {
  let records = baselineRecords ?? (await loadInstalledPluginIndexInstallRecords(params));
  for (const pluginId of pluginIds) {
    records = removePluginInstallRecordFromRecords(records, pluginId);
  }
  return migrateOfficialPluginInstallProvenance(records);
}

export async function detectPluginRegistryHealthIssues(
  params: PluginRegistryDoctorRepairParams,
): Promise<PluginRegistryHealthIssue[]> {
  const preflight = preflightPluginRegistryDoctorMigration(params);
  const issues: PluginRegistryHealthIssue[] = [];
  if (preflight.action === "migrate") {
    issues.push({
      kind: "registry-missing-or-stale",
      path: preflight.filePath,
    });
  }
  for (const plugin of listStaleManagedNpmBundledPlugins(params)) {
    issues.push({ kind: "stale-managed-npm-bundled-plugin", ...plugin });
  }
  for (const record of await listStaleLocalBundledPluginInstallRecordShadows(params)) {
    issues.push({
      kind: "stale-local-bundled-plugin-install-record",
      pluginId: record.pluginId,
      stalePath: record.stalePath,
    });
  }
  issues.push(...(await listStaleManagedNpmInstallGenerations(params)));
  const hostLinkAudit = await listPluginOpenClawHostLinkIssues(params);
  for (const issue of hostLinkAudit.peerLinkIssues) {
    issues.push({ kind: "managed-npm-openclaw-peer-link", ...issue });
  }
  for (const failure of hostLinkAudit.packageReadFailures) {
    issues.push({ kind: "managed-npm-package-unreadable", ...failure });
  }
  for (const issue of hostLinkAudit.registeredPeerLinkIssues) {
    issues.push({ kind: "registered-npm-openclaw-host-link", ...issue });
  }
  for (const failure of hostLinkAudit.registeredPackageReadFailures) {
    issues.push({ kind: "registered-npm-package-unreadable", ...failure });
  }
  return issues;
}

export function pluginRegistryIssueToHealthFinding(
  issue: PluginRegistryHealthIssue,
): HealthFinding {
  const finding = (
    message: string,
    findingPath: string,
    fixHint: string,
    target?: string,
  ): HealthFinding => ({
    checkId: PLUGIN_REGISTRY_CHECK_ID,
    severity: "warning",
    message,
    path: findingPath,
    ...(target === undefined ? {} : { target }),
    fixHint,
  });
  switch (issue.kind) {
    case "registry-missing-or-stale":
      return finding(
        "Persisted plugin registry is missing or stale.",
        issue.path,
        "Run `openclaw doctor --fix` to rebuild the plugin registry from enabled plugins.",
      );
    case "stale-managed-npm-bundled-plugin":
      return finding(
        `Managed npm package ${issue.packageName}${
          issue.version ? `@${issue.version}` : ""
        } shadows bundled plugin ${issue.pluginId}.`,
        issue.packageDir,
        "Run `openclaw doctor --fix` to remove stale managed npm packages and rebuild the plugin registry.",
        issue.pluginId,
      );
    case "stale-local-bundled-plugin-install-record":
      return finding(
        `Local install record for bundled plugin ${issue.pluginId} points at a stale path.`,
        issue.stalePath,
        "Run `openclaw doctor --fix` to remove stale local install records and rebuild the plugin registry.",
        issue.pluginId,
      );
    case "managed-npm-openclaw-peer-link":
      return finding(
        `Managed npm package ${issue.packageName} has a broken OpenClaw peer link: ${issue.reason}.`,
        issue.packageDir,
        "Run `openclaw doctor --fix` to relink managed npm plugin packages.",
        issue.packageName,
      );
    case "registered-npm-openclaw-host-link":
      return finding(
        `Registered plugin ${issue.packageName} has a broken OpenClaw host link: ${issue.reason}.`,
        issue.packageDir,
        "Run `openclaw doctor --fix` to relink the installed plugin package.",
        issue.packageName,
      );
    case "managed-npm-package-unreadable":
    case "registered-npm-package-unreadable":
      return finding(
        `${issue.kind === "managed-npm-package-unreadable" ? "Managed npm" : "Registered plugin"} package could not be inspected: ${issue.reason}.`,
        issue.packageDir,
        "Restore access to the package files, then run `openclaw doctor` again.",
      );
    default:
      return staleManagedNpmInstallGenerationToHealthFinding(issue);
  }
}

export function pluginRegistryIssueToRepairEffect(
  issue: PluginRegistryHealthIssue,
): HealthRepairEffect {
  const effect = (
    kind: HealthRepairEffect["kind"],
    action: string,
    target: string,
  ): HealthRepairEffect => ({ kind, action, target, dryRunSafe: false });
  switch (issue.kind) {
    case "registry-missing-or-stale":
      return effect("state", "would-rebuild-plugin-registry", issue.path);
    case "stale-managed-npm-bundled-plugin":
      return effect("package", "would-remove-stale-managed-npm-bundled-plugin", issue.packageDir);
    case "stale-local-bundled-plugin-install-record":
      return effect(
        "state",
        "would-remove-stale-local-bundled-plugin-install-record",
        issue.pluginId,
      );
    case "managed-npm-openclaw-peer-link":
      return effect("package", "would-relink-managed-npm-openclaw-peer", issue.packageDir);
    case "registered-npm-openclaw-host-link":
      return effect("package", "would-relink-registered-npm-openclaw-host", issue.packageDir);
    case "managed-npm-package-unreadable":
      return effect("package", "requires-managed-npm-package-readability-repair", issue.packageDir);
    case "registered-npm-package-unreadable":
      return effect(
        "package",
        "requires-registered-npm-package-readability-repair",
        issue.packageDir,
      );
    default:
      return staleManagedNpmInstallGenerationToRepairEffect(issue);
  }
}

/**
 * Runs plugin registry doctor repairs and refreshes the persisted plugin index when needed.
 *
 * Stale bundled shadows are removed before registry migration so the rebuilt index resolves the
 * current bundled source instead of an obsolete managed/local install record.
 */
export async function maybeRepairPluginRegistryState(
  params: PluginRegistryDoctorRepairParams,
): Promise<PluginRegistryDoctorRepairResult> {
  const readPreflight = () => {
    try {
      return preflightPluginRegistryDoctorMigration(params);
    } catch (error) {
      if (!(error instanceof InvalidPluginInstallRecordStateError)) {
        throw error;
      }
      note(error.message, "Plugin registry");
      return undefined;
    }
  };
  // Invalid input must not bootstrap state; only leased facts can authorize repair.
  const initial = readPreflight();
  if (!initial) {
    return { config: params.config };
  }
  if (!params.prompter.shouldRepair) {
    return await inspectOrRepairPluginRegistryState(params, initial);
  }
  return await withPluginLifecycleLease(
    resolveInstalledPluginIndexStateDatabaseOptions(params),
    async () => {
      const current = readPreflight();
      return current
        ? inspectOrRepairPluginRegistryState(params, current)
        : { config: params.config };
    },
  );
}

async function inspectOrRepairPluginRegistryState(
  params: PluginRegistryDoctorRepairParams,
  preflight: ReturnType<typeof preflightPluginRegistryDoctorMigration>,
): Promise<PluginRegistryDoctorRepairResult> {
  // Earlier Doctor stages can commit install-record repairs inside another metadata scope.
  // This refresh owns the next write, so it must start from the durable ledger.
  clearLoadInstalledPluginIndexInstallRecordsCache();

  const staleManagedNpmBundledPluginRepair = maybeRepairStaleManagedNpmBundledPlugins(params);
  const removedStaleLocalBundledPluginIds =
    await maybeRepairStaleLocalBundledPluginInstallRecords(params);
  await maybeRepairStaleManagedNpmInstallGenerations(params);
  const repairedPluginOpenClawHostLinks = await maybeRepairPluginOpenClawHostLinks(params);
  const stalePluginIdsToRemove = [
    ...new Set([
      ...(staleManagedNpmBundledPluginRepair?.removedPluginIds ?? []),
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
    return { config: params.config };
  }

  const installRecords = await loadRepairedPluginInstallRecords(
    params,
    stalePluginIdsToRemove,
    staleManagedNpmBundledPluginRepair?.installRecords,
  );
  let index: InstalledPluginIndex;
  const rebuilding = preflight.action !== "skip-existing";
  if (rebuilding) {
    const result = await migratePluginRegistryForDoctor({ ...params, installRecords });
    if (!result.migrated) {
      return { config: params.config };
    }
    index = result.current;
  } else {
    index = await refreshPluginRegistry({ ...params, reason: "migration", installRecords });
  }
  const total = index.plugins.length;
  const enabled = index.plugins.filter((plugin) => plugin.enabled).length;
  note(
    `Plugin registry ${rebuilding ? "rebuilt" : "refreshed"}: ${enabled}/${total} enabled plugins indexed.`,
    "Plugin registry",
  );
  const inventoryChanged =
    preflight.action !== "skip-existing" ||
    resolveInstalledManifestRegistryIndexFingerprint(preflight.current) !==
      resolveInstalledManifestRegistryIndexFingerprint(index) ||
    repairedPluginOpenClawHostLinks;
  return {
    config: params.config,
    ...(inventoryChanged ? { pluginInventoryChanged: true as const } : {}),
  };
}
