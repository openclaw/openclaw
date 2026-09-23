import path from "node:path";
import type { Result } from "@openclaw/normalization-core/result";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveUserPath } from "../utils.js";
import {
  isInstalledPluginIndexInstallOwnerAmbiguous,
  resolveInstalledPluginIndexInstallOwner,
} from "./installed-plugin-index-install-owner.js";
import type {
  InstalledPluginIndex,
  InstalledPluginInstallRecordInfo,
} from "./installed-plugin-index-types.js";
import { safeRealpathSync } from "./path-safety.js";

function collectDuplicateInstallRecordOwners(
  index: InstalledPluginIndex,
  env: NodeJS.ProcessEnv,
  realpathCache: Map<string, string>,
): Set<string> {
  const ownersByPath = new Map<string, string>();
  const duplicateOwners = new Set<string>();
  for (const [installOwner, record] of Object.entries(index.installRecords)) {
    const rawPath = record.installPath?.trim() || record.sourcePath?.trim();
    if (!rawPath) {
      continue;
    }
    const resolved = path.resolve(resolveUserPath(rawPath, env));
    const pathKey = safeRealpathSync(resolved, realpathCache) ?? resolved;
    const existingOwner = ownersByPath.get(pathKey);
    if (existingOwner && existingOwner !== installOwner) {
      duplicateOwners.add(existingOwner);
      duplicateOwners.add(installOwner);
    }
    ownersByPath.set(pathKey, installOwner);
  }
  return duplicateOwners;
}

export type InstalledPluginPackageOwnership = {
  installOwner: string;
  installRecord: InstalledPluginInstallRecordInfo;
  pluginIds: [string, ...string[]];
};

export type InstalledPluginLifecycleOwnership =
  | ({ kind: "package" } & InstalledPluginPackageOwnership)
  | {
      kind: "orphan";
      installOwner: string;
      installRecord: InstalledPluginInstallRecordInfo;
      pluginIds: [];
    };

export type OperatorManagedPluginUpdate = {
  kind: "operator-managed";
  pluginIds: [string];
  source?: string;
  rootDir: string;
  shadowedInstallOwner?: string;
  shadowedInstallRecord?: Pick<
    InstalledPluginInstallRecordInfo,
    "source" | "spec" | "installPath" | "sourcePath"
  >;
};

type InstalledPluginPackageOwnershipResult = Result<InstalledPluginPackageOwnership, string>;

type InstalledPluginLifecycleOwnershipResult = Result<InstalledPluginLifecycleOwnership, string>;

function ownershipError(pluginId: string, detail: string): InstalledPluginPackageOwnershipResult {
  return {
    ok: false,
    error:
      `Plugin "${pluginId}" ${detail}. ` +
      "Package maintenance requires an unambiguous install record and its discovered package owner. Refresh the plugin registry and run openclaw plugins doctor to inspect the install record before retrying.",
  };
}

// Reuse only while the index and package paths are unchanged in one synchronous
// phase. After yielding or replacing paths, create a fresh resolver.
export function createInstalledPluginOwnershipResolver(
  index: InstalledPluginIndex,
  env: NodeJS.ProcessEnv = process.env,
) {
  const targets = new Map<string, InstalledPluginIndex["plugins"][number]>();
  const childrenByOwner = new Map<string, string[]>();
  for (const entry of index.plugins) {
    if (!targets.has(entry.pluginId)) {
      targets.set(entry.pluginId, entry);
    }
    const installOwner = resolveInstalledPluginIndexInstallOwner(entry);
    if (installOwner) {
      const children = childrenByOwner.get(installOwner) ?? [];
      children.push(entry.pluginId);
      childrenByOwner.set(installOwner, children);
    }
  }
  for (const children of childrenByOwner.values()) {
    children.sort();
  }
  function resolveShadowedInstallOwner(target: InstalledPluginIndex["plugins"][number]) {
    if (Object.hasOwn(index.installRecords, target.pluginId)) {
      return target.pluginId;
    }
    // Discovery names multi-entry children <manifest-id>/<entry>; installs retain the manifest id.
    const childSeparator = target.pluginId.lastIndexOf("/");
    if (childSeparator <= 0) {
      return undefined;
    }
    const parentId = target.pluginId.slice(0, childSeparator);
    const record = index.installRecords[parentId];
    const spec = record?.resolvedSpec ?? record?.spec;
    const packageName =
      record?.resolvedName ??
      (spec ? parseRegistryNpmSpec(spec)?.name : undefined) ??
      record?.clawhubPackage;
    return target.packageName && packageName === target.packageName ? parentId : undefined;
  }
  const updateTargets = new Map(targets);
  for (const target of targets.values()) {
    if (target.origin === "config" && !resolveInstalledPluginIndexInstallOwner(target)) {
      const owner = resolveShadowedInstallOwner(target);
      if (owner && !updateTargets.has(owner)) {
        updateTargets.set(owner, target);
      }
    }
  }
  const realpathCache = new Map<string, string>();
  let duplicateOwners: Set<string> | undefined;
  const duplicates = () =>
    (duplicateOwners ??= collectDuplicateInstallRecordOwners(index, env, realpathCache));
  const unsafeOwners = new Map<string, boolean>();

  function resolvePackage(pluginId: string): InstalledPluginPackageOwnershipResult {
    const target = targets.get(pluginId);
    if (target && isInstalledPluginIndexInstallOwnerAmbiguous(target)) {
      return ownershipError(pluginId, "has ambiguous package ownership");
    }
    const ownerFromTarget = target ? resolveInstalledPluginIndexInstallOwner(target) : undefined;
    if (target && !ownerFromTarget) {
      return ownershipError(pluginId, "has no authoritative package-owner metadata");
    }

    const ownerFromRecord = Object.hasOwn(index.installRecords, pluginId) ? pluginId : undefined;
    const installOwner = ownerFromTarget ?? ownerFromRecord;
    if (!installOwner) {
      return ownershipError(pluginId, "is not associated with a tracked package install");
    }
    if (ownerFromTarget && ownerFromRecord && ownerFromTarget !== ownerFromRecord) {
      return ownershipError(pluginId, "matches conflicting package owners");
    }
    const installRecord = index.installRecords[installOwner];
    if (!installRecord) {
      return ownershipError(pluginId, `references missing package owner "${installOwner}"`);
    }
    if (duplicates().has(installOwner)) {
      return ownershipError(pluginId, `shares package path ownership with "${installOwner}"`);
    }

    const [firstPluginId, ...remainingPluginIds] = childrenByOwner.get(installOwner) ?? [];
    if (!firstPluginId) {
      return ownershipError(
        pluginId,
        `package owner "${installOwner}" has no authoritative runtime child list`,
      );
    }
    // Each result owns its child list; callers cannot mutate the prepared order.
    const pluginIds: [string, ...string[]] = [firstPluginId, ...remainingPluginIds];
    const hasUnsafePackageEntry =
      unsafeOwners.get(installOwner) ??
      index.plugins.some(
        (entry) =>
          installRecordPathMatchesPluginRoot(installRecord, entry.rootDir, env, realpathCache) &&
          resolveInstalledPluginIndexInstallOwner(entry) !== installOwner,
      );
    unsafeOwners.set(installOwner, hasUnsafePackageEntry);
    if (hasUnsafePackageEntry) {
      return ownershipError(pluginId, `package owner "${installOwner}" has conflicting child rows`);
    }
    return {
      ok: true,
      value: { installOwner, installRecord, pluginIds },
    };
  }

  function resolveLifecycle(pluginId: string): InstalledPluginLifecycleOwnershipResult {
    const ownership = resolvePackage(pluginId);
    if (ownership.ok) {
      return { ok: true, value: { kind: "package", ...ownership.value } };
    }
    const installRecord = index.installRecords[pluginId];
    if (
      !Object.hasOwn(index.installRecords, pluginId) ||
      !installRecord ||
      duplicates().has(pluginId)
    ) {
      return ownership;
    }
    const hasConflictingEntry = index.plugins.some(
      (entry) =>
        entry.pluginId === pluginId ||
        installRecordPathMatchesPluginRoot(installRecord, entry.rootDir, env, realpathCache),
    );
    if (hasConflictingEntry) {
      return ownership;
    }
    // Cleanup and pre-update planning may act on an exact durable tombstone.
    // Replacement reconciliation keeps using the strict package resolver.
    return {
      ok: true,
      value: { kind: "orphan", installOwner: pluginId, installRecord, pluginIds: [] },
    };
  }
  function resolveUpdate(
    pluginId: string,
  ): Result<InstalledPluginLifecycleOwnership | OperatorManagedPluginUpdate, string> {
    const target = updateTargets.get(pluginId);
    const shadowedInstallOwner = target ? resolveShadowedInstallOwner(target) : undefined;
    if (
      target?.origin === "config" &&
      !isInstalledPluginIndexInstallOwnerAmbiguous(target) &&
      !resolveInstalledPluginIndexInstallOwner(target) &&
      (!shadowedInstallOwner || !duplicates().has(shadowedInstallOwner))
    ) {
      const record = shadowedInstallOwner ? index.installRecords[shadowedInstallOwner] : undefined;
      return {
        ok: true,
        value: {
          kind: "operator-managed",
          pluginIds: [target.pluginId],
          source: target.source,
          rootDir: target.rootDir,
          shadowedInstallOwner,
          ...(record
            ? {
                shadowedInstallRecord: {
                  source: record.source,
                  spec: record.spec,
                  installPath: record.installPath,
                  sourcePath: record.sourcePath,
                },
              }
            : {}),
        },
      };
    }
    return resolveLifecycle(pluginId);
  }
  function resolveReload(
    pluginId: string,
  ): Result<
    | InstalledPluginLifecycleOwnership
    | { kind: "discovered"; pluginIds: [string]; installOwner?: never },
    string
  > {
    const target = targets.get(pluginId);
    // Reload can replace a discovered runtime without mutating its source files.
    // Any recorded ID, path, or ownership claim still requires strict package validation.
    if (
      target &&
      !isInstalledPluginIndexInstallOwnerAmbiguous(target) &&
      !resolveInstalledPluginIndexInstallOwner(target) &&
      !Object.hasOwn(index.installRecords, pluginId) &&
      !Object.values(index.installRecords).some((record) =>
        installRecordPathMatchesPluginRoot(record, target.rootDir, env, realpathCache),
      )
    ) {
      return { ok: true, value: { kind: "discovered", pluginIds: [pluginId] } };
    }
    return resolveLifecycle(pluginId);
  }
  function isSourceInUse(sourcePath: string, loadPaths: readonly string[]): boolean {
    const target = safeRealpathSync(sourcePath, realpathCache) ?? path.resolve(sourcePath);
    const paths = [
      ...loadPaths,
      ...Object.values(index.installRecords).flatMap((record) => [
        record.installPath,
        record.sourcePath,
      ]),
      ...index.plugins.flatMap((entry) => [entry.rootDir, entry.source, entry.manifestPath]),
    ];
    return paths.some((candidate) => {
      if (!candidate?.trim()) {
        return false;
      }
      const resolved = path.resolve(resolveUserPath(candidate, env));
      const current = safeRealpathSync(resolved, realpathCache) ?? resolved;
      return isPathInside(target, current) || isPathInside(current, target);
    });
  }
  return { resolvePackage, resolveLifecycle, resolveUpdate, resolveReload, isSourceInUse };
}

function installRecordPathMatchesPluginRoot(
  record: InstalledPluginInstallRecordInfo,
  rootDir: string,
  env: NodeJS.ProcessEnv,
  realpathCache: Map<string, string>,
): boolean {
  const resolvedRoot =
    safeRealpathSync(path.resolve(rootDir), realpathCache) ?? path.resolve(rootDir);
  return [record.installPath, record.sourcePath].some((candidate) => {
    if (!candidate?.trim()) {
      return false;
    }
    const candidatePath = path.resolve(resolveUserPath(candidate, env));
    const resolvedCandidate = safeRealpathSync(candidatePath, realpathCache) ?? candidatePath;
    return isPathInside(resolvedCandidate, resolvedRoot);
  });
}

export function hasMissingInstalledPluginOwnerMetadata(
  index: InstalledPluginIndex,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const realpathCache = new Map<string, string>();
  if (collectDuplicateInstallRecordOwners(index, env, realpathCache).size > 0) {
    return true;
  }
  const installRecords = Object.entries(index.installRecords);
  // An orphaned owner record (for example, package code removed out of band) is
  // already closed by the lifecycle resolver. It must not make every unrelated
  // config read attempt an impossible registry migration with no discoverable rows.
  return index.plugins.some(
    (plugin) =>
      isInstalledPluginIndexInstallOwnerAmbiguous(plugin) ||
      (!resolveInstalledPluginIndexInstallOwner(plugin) &&
        installRecords.some(([, record]) =>
          installRecordPathMatchesPluginRoot(record, plugin.rootDir, env, realpathCache),
        )),
  );
}
