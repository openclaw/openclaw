import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { writeJsonTarget } from "../infra/json-file.js";
import { tryReadJsonObjectSync as readJsonObject } from "../infra/json-files.js";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import type { BundledPluginSource } from "../plugins/bundled-sources.js";
import { listRecoveredManagedNpmInstallCandidates } from "../plugins/installed-plugin-index-record-reader.js";
import {
  type InstalledPluginIndexRecordStoreOptions,
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
  removePluginInstallRecordFromRecords,
  withoutPluginInstallRecords,
} from "../plugins/installed-plugin-index-records.js";
import { preservePluginSourceAdmissions } from "../plugins/installed-plugin-index-source-admissions.js";
import { resolveInstalledPluginIndexStateDatabaseOptions } from "../plugins/installed-plugin-index-store-path.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import type { InstalledPluginIndexStoreOptions } from "../plugins/installed-plugin-index-store.js";
import {
  loadInstalledPluginIndex,
  type InstalledPluginIndex,
  type LoadInstalledPluginIndexParams,
} from "../plugins/installed-plugin-index.js";
import {
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
} from "../plugins/managed-npm-retention.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import { isExternallyDistributedPlugin } from "../plugins/official-external-plugin-catalog.js";
import { createPluginCache, withPluginCache, retirePluginCache } from "../plugins/plugin-cache.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import type { OpenClawPeerLinkAuditIssue } from "../plugins/plugin-peer-link.js";
import { refreshPluginRegistry } from "../plugins/plugin-registry-refresh.js";
import { resolveControlPlaneRegistryParams } from "../plugins/plugin-registry-snapshot.js";
import { groupPluginRecords as groupRecords } from "../plugins/record-groups.js";
import {
  listStaleLocalBundledPluginInstallRecords,
  type StaleLocalBundledPluginInstallRecord,
} from "../plugins/stale-local-bundled-plugin-install-records.js";
import { normalizeOptionalTrimmedStringRecord } from "../shared/collection-input.js";
import { shortenHomePath } from "../utils.js";
import {
  resolveDoctorPluginNpmRoots,
  listPluginOpenClawHostLinkIssues,
  maybeRepairPluginOpenClawHostLinks,
} from "./doctor-plugin-host-links.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  InvalidPluginInstallRecordStateError,
  migrateOfficialPluginInstallProvenance,
  preflightPluginRegistryDoctorMigration,
} from "./doctor/shared/plugin-registry-migration.js";

const PLUGIN_REGISTRY_CHECK_ID = "core/doctor/plugin-registry";

type StaleManagedNpmInstallGenerationIssue = {
  kind: "stale-managed-npm-install-generation";
  packageDir: string;
  pluginId: string;
  version?: string;
};

type PluginGenerationDoctorParams = InstalledPluginIndexRecordStoreOptions & {
  prompter: Pick<DoctorPrompter, "shouldRepair">;
};

function normalizeManagedInstallPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? normalizeWindowsPathForComparison(resolved) : resolved;
}

async function listStaleManagedNpmInstallGenerations(
  params: InstalledPluginIndexRecordStoreOptions,
): Promise<StaleManagedNpmInstallGenerationIssue[]> {
  // The reader keeps a persisted active path authoritative and supplies its
  // deterministic recovery choice when that authority is absent or dangling.
  const activeRecords = await loadInstalledPluginIndexInstallRecords(params);
  const candidates = listRecoveredManagedNpmInstallCandidates(params);
  const candidatesByPluginId = groupRecords(candidates, (candidate) => candidate.pluginId);

  const stale: StaleManagedNpmInstallGenerationIssue[] = [];
  for (const [pluginId, pluginCandidates] of candidatesByPluginId) {
    const activeRecord = activeRecords[pluginId];
    if (activeRecord?.source !== "npm" || !activeRecord.installPath) {
      continue;
    }
    const activePath = normalizeManagedInstallPath(activeRecord.installPath);
    const active = pluginCandidates.find(
      (candidate) =>
        candidate.installRecord.installPath &&
        normalizeManagedInstallPath(candidate.installRecord.installPath) === activePath,
    );
    if (!active) {
      continue;
    }
    for (const candidate of pluginCandidates) {
      const packageDir = candidate.installRecord.installPath;
      if (!packageDir || normalizeManagedInstallPath(packageDir) === activePath) {
        continue;
      }
      stale.push({
        kind: "stale-managed-npm-install-generation",
        pluginId,
        packageDir,
        ...(candidate.installRecord.resolvedVersion
          ? { version: candidate.installRecord.resolvedVersion }
          : {}),
      });
    }
  }
  return stale.toSorted((left, right) => left.packageDir.localeCompare(right.packageDir));
}

/** Marks non-authoritative managed npm trees for safe cleanup after gateway shutdown. */
async function maybeRepairStaleManagedNpmInstallGenerations(
  params: PluginGenerationDoctorParams,
): Promise<void> {
  const stale = await listStaleManagedNpmInstallGenerations(params);
  if (stale.length === 0) {
    return;
  }
  const formatGeneration = (generation: StaleManagedNpmInstallGenerationIssue) =>
    `- ${generation.pluginId}: ${shortenHomePath(generation.packageDir)}${generation.version ? ` (${generation.version})` : ""}`;
  if (!params.prompter.shouldRepair) {
    note(
      [
        "Managed npm plugin installs have stale non-authoritative generations:",
        ...stale.map(formatGeneration),
        `Repair with ${formatCliCommand("openclaw doctor --fix")} to retire stale generations after the gateway restarts.`,
      ].join("\n"),
      "Plugin registry",
    );
    return;
  }

  const retired: StaleManagedNpmInstallGenerationIssue[] = [];
  for (const generation of stale) {
    if (
      await markRetainedManagedNpmInstall({
        packageDir: generation.packageDir,
        pluginId: generation.pluginId,
        reason: "doctor-repaired-stale-managed-npm-generation",
      })
    ) {
      retired.push(generation);
    }
  }
  if (retired.length === 0) {
    return;
  }
  clearLoadInstalledPluginIndexInstallRecordsCache();
  note(
    [
      "Retired stale managed npm plugin generation(s); they will be pruned after the gateway restarts:",
      ...retired.map(formatGeneration),
    ].join("\n"),
    "Plugin registry",
  );
}

type PluginRegistryDoctorRepairParams = Omit<LoadInstalledPluginIndexParams, "config"> &
  InstalledPluginIndexStoreOptions & {
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

function readStringMap(value: unknown): Record<string, string> {
  return (isRecord(value) ? normalizeOptionalTrimmedStringRecord(value) : undefined) ?? {};
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

  const packageLines = stale.map(
    (plugin) =>
      `- ${plugin.pluginId}: ${plugin.packageName}${plugin.version ? `@${plugin.version}` : ""}`,
  );
  if (!params.prompter.shouldRepair) {
    note(
      [
        "Managed npm plugin packages shadow bundled plugins:",
        ...packageLines,
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
      ...packageLines,
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
      return {
        checkId: PLUGIN_REGISTRY_CHECK_ID,
        severity: "warning",
        category: "recommended",
        docsUrl: "https://docs.openclaw.ai/cli/doctor/checks",
        message: `Managed npm plugin ${issue.pluginId}${issue.version ? `@${issue.version}` : ""} is a stale non-authoritative generation.`,
        path: issue.packageDir,
        target: issue.pluginId,
        fixHint:
          "Run `openclaw doctor --fix` to retire the stale generation for pruning after the gateway restarts.",
      };
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
      return {
        kind: "package",
        action: "would-retire-stale-managed-npm-install-generation",
        target: issue.packageDir,
        dryRunSafe: false,
      };
  }
}

/**
 * Runs plugin registry doctor repairs and refreshes the persisted plugin index when needed.
 *
 * Stale bundled shadows are removed before registry migration so the rebuilt index resolves the
 * current bundled source instead of an obsolete managed/local install record.
 */
export async function maybeRepairPluginRegistryState(
  input: PluginRegistryDoctorRepairParams,
): Promise<PluginRegistryDoctorRepairResult> {
  const params = resolveControlPlaneRegistryParams(input);
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
  const cache = createPluginCache();
  try {
    const unchanged = await withPluginCache(cache, async () => {
      const preflight = readPreflight();
      if (preflight?.action !== "skip-existing") {
        return false;
      }
      // Rediscover the complete inventory. Even acquiring and releasing a
      // durable plugin lease dirties SQLite, so stop before that write on a no-op.
      const current = loadInstalledPluginIndex({
        ...params,
        config: withoutPluginInstallRecords(params.config),
        installRecords: await loadRepairedPluginInstallRecords(params, []),
      });
      preservePluginSourceAdmissions(preflight.current, current);
      return (
        isDeepStrictEqual(preflight.current, {
          ...current,
          generatedAtMs: preflight.current.generatedAtMs,
          refreshReason: preflight.current.refreshReason,
        }) && (await detectPluginRegistryHealthIssues(params)).length === 0
      );
    });
    if (unchanged) {
      return { config: params.config };
    }
  } finally {
    await retirePluginCache(cache);
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
    index = {
      ...loadInstalledPluginIndex({
        ...params,
        config: withoutPluginInstallRecords(params.config),
        installRecords,
      }),
      refreshReason: "migration",
    };
    await writePersistedInstalledPluginIndex(index, params);
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
