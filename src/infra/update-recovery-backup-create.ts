import fs from "node:fs/promises";
import path from "node:path";
import { resolveBackupPlanFromDisk } from "../commands/backup-shared.js";
import {
  parseUpdateRecoveryBackupManifest,
  type UpdateRecoveryBackupManifest,
} from "../commands/backup-verify-manifest.js";
import { collectDoctorSkillWorkshopBackupResources } from "../commands/doctor-skill-workshop-readonly.js";
import { resolveStartupConfigSnapshot } from "../commands/doctor/shared/automatic-startup-config-repair.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import { collectPluginDoctorMigrationBackupResources } from "../plugins/doctor-contract-registry.js";
import { ensurePrivateSnapshotRepositoryRoot } from "../snapshot/local-repository.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import { inspectOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry-listing.js";
import { assertOpenClawStateDatabaseOwner } from "../state/openclaw-state-db-maintenance.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { isVolatileBackupPath } from "./backup-volatile-filter.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { pinDirectory, requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { copyFileHandle, sameFileMutationFingerprint } from "./file-descriptor.js";
import { root as safeRoot } from "./fs-safe.js";
import { SQLITE_SIDECAR_SUFFIXES } from "./sqlite-files.js";
import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import type { UpdateRecoveryBackupRef } from "./update-recovery-backup-contract.js";
import {
  backupStore,
  canonicalEntryPath,
  digest,
  fileDigest,
  installDirectory,
  MAX_MANIFEST_BYTES,
  statOrMissing,
} from "./update-recovery-backup-files.js";
import { readUpdateRunDriver, type UpdateRunDriver } from "./update-run-driver.js";

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

async function isSqlite(pathname: string): Promise<boolean> {
  if (pathname.endsWith(".sqlite")) {
    return true;
  }
  const handle = await fs.open(pathname, "r");
  try {
    const header = Buffer.alloc(16);
    const result = await handle.read(header, 0, 16, 0);
    return result.bytesRead === 16 && header.toString() === "SQLite format 3\0";
  } finally {
    await handle.close();
  }
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

export async function captureUpdateRecoveryBackup(params: {
  assertOwned: () => void;
  runId: string;
  installRoot: string;
  drivers?: UpdateRunDriver[];
}): Promise<UpdateRecoveryBackupRef> {
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
  if (plan.skipped.some((entry) => entry.reason === "unresolved")) {
    throw new Error(
      "Cannot create a complete update recovery backup while config ownership is unresolved. Run npx openclaw@latest doctor --fix, then retry the update.",
    );
  }
  const config = await readConfigFileSnapshot({ observe: false });
  const stateDir = resolvePathViaExistingAncestorSync(plan.stateDir);
  const installRoot = path.resolve(params.installRoot);
  const directory = path.join(installDirectory(installRoot, stateDir), params.runId, "backup");
  const registry = inspectOpenClawRegisteredAgentDatabases({
    includeIncompatibleSchemaVersions: true,
  });
  const discoveryConfig = (resolveStartupConfigSnapshot(config) ?? config).config;
  const configuredDatabases = resolveConfiguredAgentDatabaseTargets(discoveryConfig, {
    env: process.env,
    registeredDatabases: registry,
  });
  const resourceConfig =
    config.sourceConfigBeforeMigrations ?? config.sourceConfig ?? discoveryConfig;
  const resources = (
    await Promise.all([
      collectPluginDoctorMigrationBackupResources({
        config: resourceConfig,
        env: process.env,
        stateDir,
      }),
      collectDoctorSkillWorkshopBackupResources({ config: resourceConfig, env: process.env }),
    ])
  ).flat();
  const declaredKinds = new Map(
    resources.map((resource) => [canonicalEntryPath(resource.path), resource.kind]),
  );
  const resourcePaths = [...declaredKinds.keys()];
  const directoryResources = [...declaredKinds].flatMap(([pathname, kind]) =>
    kind === "directory" ? [pathname] : [],
  );
  const databaseOwners = new Map<string, { role: "global" } | { role: "agent"; agentId: string }>();
  databaseOwners.set(canonicalEntryPath(resolveOpenClawStateSqlitePath()), { role: "global" });
  for (const database of [
    ...registry,
    ...configuredDatabases,
    ...plan.inventory.agentRoots.map((root) => ({
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
  for (const pathname of databaseOwners.keys()) {
    declaredKinds.set(pathname, "sqlite");
  }
  const includePaths = (config.includeProvenance ?? []).flatMap(
    (owner) => owner.targetPaths ?? (owner.targetPath ? [owner.targetPath] : []),
  );
  const explicitPaths = [
    plan.configPath,
    ...includePaths,
    resolveOpenClawStateSqlitePath(),
    ...plan.inventory.agentRoots.map((root) => root.databasePath),
    ...registry.map((database) => database.path),
    ...configuredDatabases.map((database) => database.path),
    ...resources.map((resource) => resource.path),
  ].map(canonicalEntryPath);
  const configFiles = new Set([plan.configPath, ...includePaths].map(canonicalEntryPath));
  const rawFiles = new Set([
    ...configFiles,
    ...resources
      .filter((resource) => resource.kind === "file")
      .map((resource) => canonicalEntryPath(resource.path)),
  ]);
  const roots = [...new Set(explicitPaths)]
    .toSorted((a, b) => a.length - b.length)
    .filter((root, index, all) => !all.slice(0, index).some((other) => within(root, other)));
  const scanRoots = [
    ...new Set([stateDir, ...plan.inventory.agentRoots.map((root) => root.sourcePath), ...roots]),
  ];
  if (roots.some((root) => root === path.parse(root).root || within(root, backupStore(stateDir)))) {
    throw new Error(
      "Update recovery cannot capture a filesystem root or a root containing its backup store.",
    );
  }
  const manifest: UpdateRecoveryBackupManifest = {
    schemaVersion: 1,
    kind: "update-recovery",
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
      ...plan.inventory.regenerableRoots.map((root) => root.sourcePath),
      backupStore(stateDir),
      resolvePathViaExistingAncestorSync(resolveGatewayLockDir(stateDir)),
      ...[plan.configPath, ...includePaths].map((pathname) =>
        canonicalEntryPath(`${pathname}.lock`),
      ),
    ],
    protectedPaths: [
      ...new Set([
        ...explicitPaths,
        ...plan.included.filter((asset) => asset.kind !== "state").map((asset) => asset.sourcePath),
      ]),
    ],
    entries: [],
  };
  const seen = new Set<string>();
  const rootStates = new Map(
    await Promise.all(
      roots.map(async (pathname) => [pathname, await statOrMissing(pathname)] as const),
    ),
  );
  params.assertOwned();
  await ensurePrivateSnapshotRepositoryRoot(directory);
  const directoryPin = await pinDirectory(directory);
  await createPrivateSqliteDirectory(path.join(directory, "payload"));
  const visit = async (pathname: string): Promise<void> => {
    if (seen.has(pathname) || !traversable(manifest, pathname)) {
      return;
    }
    const declaredPath =
      explicitPaths.includes(pathname) ||
      resourcePaths.some((resource) => within(pathname, resource) || within(resource, pathname));
    if (!plan.inventory.isTraversable(pathname) && !declaredPath) {
      return;
    }
    if (manifest.entries.length >= 1_000_000) {
      throw new Error("Update recovery inventory exceeds one million entries.");
    }
    seen.add(pathname);
    params.assertOwned();
    await directoryPin.assertCurrent();
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
        if (plan.inventory.isPackageContent(child) && !declaredResource) {
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
      const sqliteLink = declaredKinds.get(pathname) === "sqlite" || pathname.endsWith(".sqlite");
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
      const link: Extract<UpdateRecoveryBackupManifest["entries"][number], { kind: "symlink" }> = {
        kind: "symlink",
        sourcePath: pathname,
        target: await fs.readlink(pathname),
      };
      manifest.entries.push(link);
      if (sqliteLink || configFiles.has(pathname) || declaredKinds.get(pathname) === "directory") {
        const target = await fs.realpath(pathname);
        if (sqliteLink) {
          declaredKinds.set(target, "sqlite");
        } else if (configFiles.has(pathname)) {
          link.contentPath = target;
          configFiles.add(target);
          rawFiles.add(target);
        } else {
          declaredKinds.set(target, "directory");
          directoryResources.push(target);
          resourcePaths.push(target);
        }
        explicitPaths.push(target);
        const owner = databaseOwners.get(pathname);
        if (owner) {
          databaseOwners.set(target, owner);
        }
        if (!manifest.roots.some((root) => within(target, root))) {
          manifest.roots.push(target);
          manifest.protectedPaths.push(target);
        }
        await visit(target);
      }
      return;
    }
    if (!before.isFile()) {
      manifest.excludedRoots.push(pathname);
      return;
    }
    const declaredKind = declaredKinds.get(pathname);
    const sidecarSuffix = SQLITE_SIDECAR_SUFFIXES.find((suffix) => pathname.endsWith(suffix));
    if (declaredKind !== "file" && sidecarSuffix) {
      const databasePath = pathname.slice(0, -sidecarSuffix.length);
      const database = await statOrMissing(databasePath);
      const sqliteOwner =
        declaredKinds.get(databasePath) === "sqlite" ||
        databasePath.endsWith(".sqlite") ||
        (database?.isFile() && (await isSqlite(databasePath)));
      if (sqliteOwner) {
        if (!database) {
          throw new Error(`SQLite database has an orphaned sidecar: ${pathname}`);
        }
        return;
      }
    }
    const sqlite =
      declaredKind === "sqlite" || (declaredKind !== "file" && (await isSqlite(pathname)));
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
    const archivePath = `payload/${manifest.entries.length}`;
    const targetPath = path.join(directory, archivePath);
    params.assertOwned();
    if (sqlite) {
      const owner = databaseOwners.get(pathname);
      await createVerifiedSqliteSnapshot({
        sourcePath: pathname,
        targetPath,
        preserveRowIds: true,
        beforePublish: params.assertOwned,
        validate:
          owner?.role === "global"
            ? (database, label) => assertOpenClawStateDatabaseOwner(database, { pathname: label })
            : owner?.role === "agent"
              ? (database, label) => {
                  assertOpenClawAgentDatabaseOwner(database, {
                    agentId: owner.agentId,
                    pathname: label,
                  });
                }
              : undefined,
      });
    } else {
      const source = await (
        await safeRoot(path.dirname(pathname))
      ).open(path.basename(pathname), { symlinks: "reject", hardlinks: "allow" });
      const output = await fs.open(targetPath, "wx+", 0o600);
      try {
        if (before.dev !== source.stat.dev || before.ino !== source.stat.ino) {
          throw new Error(`Update recovery input changed before backup: ${pathname}`);
        }
        const opened = await source.handle.stat({ bigint: true });
        await copyFileHandle(source.handle, output, {
          noProgressMessage: "Update recovery input copy made no progress.",
        });
        if (!sameFileMutationFingerprint(opened, await source.handle.stat({ bigint: true }))) {
          throw new Error(`Update recovery input changed during backup: ${pathname}`);
        }
        await output.sync();
      } finally {
        await output.close();
        await source.handle.close();
      }
      const after = await fs.lstat(pathname);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      ) {
        throw new Error(`Update recovery input changed during backup: ${pathname}`);
      }
    }
    const content = await fileDigest(targetPath);
    manifest.entries.push({
      kind: "file",
      sourcePath: pathname,
      archivePath,
      ...content,
      sqlite,
      mode: before.mode & 0o777,
    });
  };
  try {
    for (const root of scanRoots) {
      await visit(root);
    }
    // Missing configured databases must remain absent after rolling back their first migration.
    for (const pathname of explicitPaths) {
      if (!seen.has(pathname)) {
        await visit(pathname);
      }
    }
    manifest.configPaths = [...configFiles].toSorted();
    const raw = `${JSON.stringify(manifest)}\n`;
    if (Buffer.byteLength(raw) > MAX_MANIFEST_BYTES) {
      throw new Error("Update recovery inventory exceeds its manifest size bound.");
    }
    parseUpdateRecoveryBackupManifest(raw);
    const manifestPath = path.join(directory, "manifest.json");
    params.assertOwned();
    await directoryPin.assertCurrent();
    const output = await fs.open(manifestPath, "wx", 0o600);
    try {
      await output.writeFile(raw);
      await output.sync();
    } finally {
      await output.close();
    }
    requireDirectorySync(
      await syncDirectory(path.join(directory, "payload")),
      "Update recovery payload",
    );
    requireDirectorySync(await directoryPin.sync(), "Update recovery backup");
    const ref = { directory, manifestPath, manifestSha256: digest(raw) };
    return ref;
  } catch (error) {
    throw new Error(
      `Update recovery backup failed before migrations; retained partial backup: ${directory}`,
      { cause: error },
    );
  } finally {
    await directoryPin.close();
  }
}
