import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveBackupPlanFromDisk } from "../commands/backup-shared.js";
import type { UpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { collectDoctorSkillWorkshopBackupResources } from "../commands/doctor-update-rehearsal-workshop.js";
import { resolveLegacyConfigSnapshotForBackup } from "../commands/doctor/shared/automatic-config-repair.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { PluginDoctorMigrationBackupWarning } from "../plugins/doctor-contract-module.js";
import { collectPluginDoctorMigrationBackupResources } from "../plugins/doctor-contract-registry.js";
import { inspectOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry-listing.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { isVolatileBackupPath } from "./backup-volatile-filter.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { isMissingPathError } from "./errno.js";
import { isSqliteSnapshotFile } from "./sqlite-file-header.js";
import { SQLITE_SIDECAR_SUFFIXES } from "./sqlite-files.js";
import { assertNotUpdateCapturePath, isUpdateCapturePath } from "./update-capture-paths.js";
import type { UpdateRecoveryBackupRef } from "./update-recovery-backup-contract.js";
import {
  backupStore,
  canonicalEntryPath,
  captureDirectory,
  statOrMissing,
} from "./update-recovery-backup-files.js";
import { retainedUpdateRecoveryResources } from "./update-recovery-backup-resources.js";
import { assertUpdateRecoveryCapacity } from "./update-recovery-capacity.js";
import type { UpdateRecoverySourcePublication } from "./update-recovery-source-publication.js";
import { readUpdateRunDriver, type UpdateRunDriver } from "./update-run-driver.js";
function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function included(
  manifest: Pick<UpdateRecoveryBackupManifest, "stateDir" | "excludedRoots" | "protectedPaths">,
  pathname: string,
): boolean {
  const excluded = manifest.excludedRoots.find((root) => within(pathname, root));
  if (
    excluded &&
    !manifest.protectedPaths.some((root) => within(pathname, root) && within(root, excluded))
  ) {
    return false;
  }
  const protectedPath = manifest.protectedPaths.some((root) => within(pathname, root));
  return protectedPath || !isVolatileBackupPath(pathname, { stateDirs: [manifest.stateDir] });
}

function traversable(
  manifest: Pick<UpdateRecoveryBackupManifest, "stateDir" | "excludedRoots" | "protectedPaths">,
  pathname: string,
): boolean {
  return (
    included(manifest, pathname) || manifest.protectedPaths.some((root) => within(root, pathname))
  );
}

export type UpdateRecoveryCaptureParams = {
  assertOwned: () => void;
  env: NodeJS.ProcessEnv;
  runId: string;
  installRoot: string;
  drivers?: UpdateRunDriver[];
  baseline?: { ref: UpdateRecoveryBackupRef; manifest: UpdateRecoveryBackupManifest };
  sourcePublication?: UpdateRecoverySourcePublication;
};

export async function inspectUpdateRecoveryBackup(params: UpdateRecoveryCaptureParams) {
  params.assertOwned();
  const creator = readUpdateRunDriver();
  if (!creator) {
    throw new Error(
      "Cannot identify the update backup creator; stop the Gateway and retry from a supported host.",
    );
  }
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(params.runId)) {
    throw new Error("Invalid update recovery run id.");
  }
  const plan = await resolveBackupPlanFromDisk({ includeWorkspace: false });
  const config = await readConfigFileSnapshot({ observe: false });
  const stateDir = resolvePathViaExistingAncestorSync(plan.stateDir);
  const installRoot = path.resolve(params.installRoot);
  const directory = params.baseline
    ? path.join(captureDirectory(params.runId, stateDir), "candidate")
    : captureDirectory(params.runId, stateDir);
  if (
    params.baseline &&
    (params.baseline.ref.directory !== captureDirectory(params.runId, stateDir) ||
      params.baseline.manifest.runId !== params.runId ||
      params.baseline.manifest.installRoot !== installRoot ||
      params.baseline.manifest.schemaVersion !== 2 ||
      params.baseline.manifest.generation?.kind !== "baseline")
  ) {
    throw new Error("Candidate capture requires the original v2 baseline for this installation.");
  }
  const registry = await inspectOpenClawRegisteredAgentDatabases({
    env: params.env,
    includeIncompatibleSchemaVersions: true,
  });
  const discoveryConfig = (resolveLegacyConfigSnapshotForBackup(config) ?? config).config;
  const configuredDatabases = resolveConfiguredAgentDatabaseTargets(discoveryConfig, {
    env: params.env,
    registeredDatabases: registry,
  });
  const resourceConfig =
    config.sourceConfigBeforeMigrations ?? config.sourceConfig ?? discoveryConfig;
  const resourceWarnings: PluginDoctorMigrationBackupWarning[] = [];
  const resources = (
    await Promise.all([
      collectPluginDoctorMigrationBackupResources({
        config: resourceConfig,
        env: params.env,
        stateDir,
        warnings: resourceWarnings,
        requireLocalResources: true,
      }),
      collectDoctorSkillWorkshopBackupResources({ config: resourceConfig, env: params.env }),
    ])
  ).flat();
  // Removed declarations still belong to this operation. Capture their current
  // bytes/absence as well as the newly discovered closure, never just B or C.
  const retainedResources = retainedUpdateRecoveryResources(params.baseline?.manifest);
  const declaredKinds = new Map<string, "directory" | "sqlite" | "file">();
  const declareResource = (pathname: string, kind: "directory" | "sqlite" | "file") => {
    const canonical = canonicalEntryPath(pathname);
    const previous = declaredKinds.get(canonical);
    if (previous !== undefined && previous !== kind) {
      throw new Error(`Update recovery has conflicting resource kinds: ${canonical}`);
    }
    declaredKinds.set(canonical, kind);
  };
  for (const resource of [...retainedResources, ...resources]) {
    declareResource(resource.path, resource.kind);
  }
  const resourcePaths = [...declaredKinds.keys()];
  const directoryResources = [...declaredKinds].flatMap(([pathname, kind]) =>
    kind === "directory" ? [pathname] : [],
  );
  const databaseOwners = new Map<string, { role: "global" } | { role: "agent"; agentId: string }>();
  databaseOwners.set(canonicalEntryPath(resolveOpenClawStateSqlitePath(params.env)), {
    role: "global",
  });
  for (const database of [
    ...registry,
    ...configuredDatabases,
    ...plan.resources.agentRoots.map((root) => ({
      agentId: root.agentId,
      path: root.databasePath,
    })),
  ]) {
    const pathname = canonicalEntryPath(database.path);
    const previous = databaseOwners.get(pathname);
    if (previous && (previous.role !== "agent" || previous.agentId !== database.agentId)) {
      throw new Error(`Update recovery database has conflicting owners: ${pathname}`);
    }
    databaseOwners.set(pathname, { role: "agent", agentId: database.agentId });
  }
  for (const retained of params.baseline?.manifest.databases ?? []) {
    const current = databaseOwners.get(retained.path);
    if (
      current &&
      (current.role !== retained.role ||
        (current.role === "agent" &&
          retained.role === "agent" &&
          current.agentId !== retained.agentId))
    ) {
      throw new Error(`Update recovery database changed owners: ${retained.path}`);
    }
    databaseOwners.set(
      retained.path,
      retained.role === "global"
        ? { role: "global" }
        : { role: "agent", agentId: retained.agentId },
    );
  }
  for (const pathname of databaseOwners.keys()) {
    declareResource(pathname, "sqlite");
  }
  const includePaths = (config.includeProvenance ?? []).flatMap(
    (owner) => owner.targetPaths ?? (owner.targetPath ? [owner.targetPath] : []),
  );
  const protectedPaths = [
    plan.configPath,
    ...includePaths,
    resolveOpenClawStateSqlitePath(params.env),
    ...plan.resources.agentRoots.map((root) => root.databasePath),
    ...registry.map((database) => database.path),
    ...configuredDatabases.map((database) => database.path),
    ...resources.map((resource) => resource.path),
    ...(params.baseline?.manifest.protectedPaths ?? []),
  ].map(canonicalEntryPath);
  const explicitPaths = [
    ...protectedPaths,
    ...(params.baseline?.manifest.entries.map((entry) => entry.sourcePath) ?? []),
  ];
  const configFiles = new Set(
    [plan.configPath, ...includePaths, ...(params.baseline?.manifest.configPaths ?? [])].map(
      canonicalEntryPath,
    ),
  );
  const rawFiles = new Set([
    ...configFiles,
    ...[...declaredKinds].flatMap(([pathname, kind]) => (kind === "file" ? [pathname] : [])),
  ]);
  const roots = [...new Set(explicitPaths)]
    .toSorted((a, b) => a.length - b.length)
    .filter((root, index, all) => !all.slice(0, index).some((other) => within(root, other)));
  const scanRoots = [
    ...new Set([stateDir, ...plan.resources.agentRoots.map((root) => root.sourcePath), ...roots]),
  ];
  const assertCaptureRoot = (pathname: string) => {
    const store = backupStore(stateDir);
    if (
      pathname === path.parse(pathname).root ||
      within(pathname, store) ||
      within(store, pathname)
    ) {
      throw new Error(
        "Update recovery cannot capture a filesystem root or a root containing its backup store.",
      );
    }
    assertNotUpdateCapturePath(pathname, stateDir);
  };
  for (const root of roots) {
    assertCaptureRoot(root);
  }
  const manifest: UpdateRecoveryBackupManifest = {
    schemaVersion: 2,
    kind: "update-recovery",
    generation: params.baseline
      ? { kind: "candidate", baselineSha256: params.baseline.ref.manifestSha256 }
      : { kind: "baseline" },
    databases: [],
    runId: params.runId,
    installRoot,
    stateDir,
    configPath: canonicalEntryPath(plan.configPath),
    configPaths: [...configFiles],
    creator,
    drivers: params.drivers ?? [],
    createdAt: new Date().toISOString(),
    roots,
    excludedRoots: [
      ...plan.resources.regenerableRoots.map((root) => root.sourcePath),
      backupStore(stateDir),
      resolvePathViaExistingAncestorSync(resolveGatewayLockDir(stateDir)),
      ...[plan.configPath, ...includePaths].map((pathname) =>
        canonicalEntryPath(`${pathname}.lock`),
      ),
    ],
    protectedPaths: [
      ...new Set([
        ...protectedPaths,
        ...plan.included.filter((asset) => asset.kind !== "state").map((asset) => asset.sourcePath),
      ]),
    ],
    entries: [],
    warnings: resourceWarnings,
  };
  type RecoveryAlias = {
    target: string;
    dangling: boolean;
    kind: "directory" | "sqlite" | "file";
    link: Extract<UpdateRecoveryBackupManifest["entries"][number], { kind: "symlink" }>;
  };
  const aliases = new Map<string, RecoveryAlias>();
  const resolvingAliases = new Set<string>();
  const retainAliasTarget = (pathname: string, kind: RecoveryAlias["kind"]) => {
    declareResource(pathname, kind);
    if (!resourcePaths.includes(pathname)) {
      resourcePaths.push(pathname);
    }
    if (kind === "directory" && !directoryResources.includes(pathname)) {
      directoryResources.push(pathname);
    }
    if (kind === "file") {
      rawFiles.add(pathname);
    }
    if (!explicitPaths.includes(pathname)) {
      explicitPaths.push(pathname);
    }
    if (!manifest.protectedPaths.includes(pathname)) {
      manifest.protectedPaths.push(pathname);
    }
    if (!manifest.roots.some((root) => within(pathname, root))) {
      manifest.roots.push(pathname);
    }
  };
  const admitAlias = async (pathname: string): Promise<RecoveryAlias> => {
    if (aliases.has(pathname)) {
      return aliases.get(pathname)!;
    }
    if (resolvingAliases.has(pathname)) {
      throw new Error(`Update recovery aliases form a cycle: ${pathname}`);
    }
    resolvingAliases.add(pathname);
    const linkTarget = await fs.readlink(pathname);
    const immediateTarget = path.resolve(path.dirname(pathname), linkTarget);
    const immediateStat = await statOrMissing(immediateTarget);
    let downstream: RecoveryAlias | undefined;
    if (immediateStat?.isSymbolicLink()) {
      const declaredKind =
        declaredKinds.get(pathname) ?? (configFiles.has(pathname) ? "file" : undefined);
      if (declaredKind) {
        declareResource(immediateTarget, declaredKind);
      }
      if (configFiles.has(pathname)) {
        configFiles.add(immediateTarget);
      }
      downstream = await admitAlias(immediateTarget);
    }
    let target: string;
    let kind: RecoveryAlias["kind"] | undefined;
    let dangling = false;
    try {
      target = await fs.realpath(pathname);
    } catch (error) {
      if (
        !isMissingPathError(error) ||
        configFiles.has(pathname) ||
        databaseOwners.has(pathname) ||
        declaredKinds.get(pathname) === "sqlite"
      ) {
        throw error;
      }
      target = downstream?.target ?? immediateTarget;
      assertCaptureRoot(target);
      kind =
        declaredKinds.get(pathname) ??
        (configFiles.has(pathname) ? "file" : downstream?.kind) ??
        "file";
      dangling = true;
    }
    if (!dangling) {
      assertCaptureRoot(target);
      const targetStat = await fs.stat(target);
      kind =
        declaredKinds.get(pathname) ??
        (configFiles.has(pathname) ? "file" : downstream?.kind) ??
        declaredKinds.get(target) ??
        (targetStat.isDirectory()
          ? "directory"
          : pathname.endsWith(".sqlite") || (await isSqliteSnapshotFile(target))
            ? "sqlite"
            : "file");
      if (kind === "directory" ? !targetStat.isDirectory() : !targetStat.isFile()) {
        throw new Error(
          `Declared recovery ${kind} symlink has an incompatible target: ${pathname}`,
        );
      }
    }
    if (!kind) {
      throw new Error(`Update recovery could not classify alias target: ${pathname}`);
    }
    retainAliasTarget(target, kind);
    if (downstream) {
      retainAliasTarget(immediateTarget, kind);
    }
    const link: Extract<UpdateRecoveryBackupManifest["entries"][number], { kind: "symlink" }> = {
      kind: "symlink",
      sourcePath: pathname,
      target: linkTarget,
      contentPath: target,
    };
    if (configFiles.has(pathname)) {
      configFiles.add(target);
    }
    const owner = databaseOwners.get(pathname);
    if (owner) {
      const existing = databaseOwners.get(target);
      if (
        existing &&
        (existing.role !== owner.role ||
          (existing.role === "agent" &&
            owner.role === "agent" &&
            existing.agentId !== owner.agentId))
      ) {
        throw new Error(`Update recovery database has conflicting owners: ${target}`);
      }
      databaseOwners.delete(pathname);
      databaseOwners.set(target, owner);
    }
    const alias = { target, dangling, kind, link };
    aliases.set(pathname, alias);
    resolvingAliases.delete(pathname);
    return alias;
  };
  const assertDeclaredType = (pathname: string, stat: Stats | undefined) => {
    const kind = declaredKinds.get(pathname) ?? (configFiles.has(pathname) ? "file" : undefined);
    if (
      stat &&
      kind &&
      !stat.isSymbolicLink() &&
      (kind === "directory" ? !stat.isDirectory() : !stat.isFile())
    ) {
      throw new Error(`Declared recovery ${kind} has an incompatible type: ${pathname}`);
    }
  };
  // Resolve authored and retained aliases before scanning. Their targets may sort
  // before the alias and must already have their file/directory classification.
  // Alias admission appends targets; visit only the original authored inputs here.
  const aliasInputs = explicitPaths.slice();
  for (const pathname of aliasInputs) {
    const stat = await statOrMissing(pathname);
    assertDeclaredType(pathname, stat);
    if (stat?.isSymbolicLink()) {
      await admitAlias(pathname);
    }
  }
  const seen = new Set<string>();
  const rootStates = new Map(
    await Promise.all(
      roots.map(async (pathname) => [pathname, await statOrMissing(pathname)] as const),
    ),
  );
  const files: {
    pathname: string;
    before: Stats;
    sqlite: boolean;
    sidecars: Array<Stats | undefined>;
  }[] = [];
  const visit = async (pathname: string): Promise<void> => {
    if (seen.has(pathname) || !traversable(manifest, pathname)) {
      return;
    }
    if (isUpdateCapturePath(pathname, stateDir)) {
      // Restore must preserve the same private capture roots that inventory omits.
      manifest.excludedRoots.push(pathname);
      return;
    }
    const declaredPath =
      explicitPaths.includes(pathname) ||
      resourcePaths.some((resource) => within(pathname, resource) || within(resource, pathname));
    if (!plan.resources.isTraversable(pathname) && !declaredPath) {
      return;
    }
    if (seen.size >= 1_000_000) {
      throw new Error("Update recovery inventory exceeds one million entries.");
    }
    seen.add(pathname);
    params.assertOwned();
    const before = rootStates.has(pathname)
      ? rootStates.get(pathname)
      : await statOrMissing(pathname);
    if (!before) {
      if (!explicitPaths.includes(pathname)) {
        return;
      }
      if (declaredKinds.get(pathname) === "sqlite") {
        for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
          if (await statOrMissing(`${pathname}${suffix}`)) {
            throw new Error(`SQLite database has an orphaned sidecar: ${pathname}${suffix}`);
          }
        }
      }
      manifest.entries.push({
        kind: "missing",
        sourcePath: pathname,
        sqlite: declaredKinds.get(pathname) === "sqlite",
        directory: declaredKinds.get(pathname) === "directory",
      });
      return;
    }
    assertDeclaredType(pathname, before);
    if (before.isDirectory()) {
      if (directoryResources.some((resource) => within(pathname, resource))) {
        manifest.entries.push({
          kind: "directory",
          sourcePath: pathname,
          mode: before.mode & 0o777,
        });
      }
      for (const name of (await fs.readdir(pathname)).toSorted()) {
        const child = path.join(pathname, name);
        const declaredResource = resourcePaths.some(
          (resource) => within(child, resource) || within(resource, child),
        );
        if (plan.resources.isPackageContent(child) && !declaredResource) {
          manifest.excludedRoots.push(child);
          continue;
        }
        await visit(child);
      }
      return;
    }
    if (!included(manifest, pathname)) {
      return;
    }
    if (before.isSymbolicLink()) {
      const kind = declaredKinds.get(pathname);
      const sqliteLink = kind === "sqlite" || (kind === undefined && pathname.endsWith(".sqlite"));
      if (
        !sqliteLink &&
        !rawFiles.has(pathname) &&
        !directoryResources.some((resource) => within(pathname, resource))
      ) {
        return;
      }
      if (!manifest.roots.some((root) => within(pathname, root))) {
        manifest.roots.push(pathname);
      }
      const alias = await admitAlias(pathname);
      if (
        (await fs.readlink(pathname)) !== alias.link.target ||
        (!alias.dangling && (await fs.realpath(pathname)) !== alias.target)
      ) {
        throw new Error(`Update recovery symlink changed during inventory: ${pathname}`);
      }
      manifest.entries.push(alias.link);
      await visit(alias.target);
      return;
    }
    if (!before.isFile()) {
      if (declaredPath) {
        throw new Error(
          `Update recovery cannot preserve an unknown declared resource type: ${pathname}`,
        );
      }
      manifest.excludedRoots.push(pathname);
      return;
    }
    const declaredKind = declaredKinds.get(pathname);
    const sidecarSuffix = SQLITE_SIDECAR_SUFFIXES.find((suffix) => pathname.endsWith(suffix));
    if (declaredKind !== "file" && sidecarSuffix) {
      const databasePath = pathname.slice(0, -sidecarSuffix.length);
      const database = await statOrMissing(databasePath);
      const databaseKind = declaredKinds.get(databasePath);
      const sqliteOwner =
        databaseKind === "sqlite" ||
        (databaseKind === undefined &&
          (databasePath.endsWith(".sqlite") ||
            (database?.isFile() && (await isSqliteSnapshotFile(databasePath)))));
      if (sqliteOwner) {
        if (!database) {
          throw new Error(`SQLite database has an orphaned sidecar: ${pathname}`);
        }
        return;
      }
    }
    const sqlite =
      declaredKind === "sqlite" ||
      (declaredKind !== "file" && (await isSqliteSnapshotFile(pathname)));
    if (
      !sqlite &&
      !rawFiles.has(pathname) &&
      !directoryResources.some((resource) => within(pathname, resource))
    ) {
      return;
    }
    if (!manifest.roots.some((root) => within(pathname, root))) {
      manifest.roots.push(pathname);
    }
    const sidecars = sqlite
      ? await Promise.all(
          SQLITE_SIDECAR_SUFFIXES.map((suffix) => statOrMissing(`${pathname}${suffix}`)),
        )
      : [];
    files.push({ pathname, before, sqlite, sidecars });
  };
  for (const root of scanRoots) {
    await visit(root);
  }
  // Missing configured databases must remain absent after rolling back their first migration.
  for (const pathname of explicitPaths) {
    if (!seen.has(pathname)) {
      await visit(pathname);
    }
  }
  await assertUpdateRecoveryCapacity({
    directory,
    installRoot,
    files: files.map(({ pathname, before, sqlite }) => ({ pathname, size: before.size, sqlite })),
  });
  params.assertOwned();
  return { manifest, directory, stateDir, files, databaseOwners, configFiles };
}
