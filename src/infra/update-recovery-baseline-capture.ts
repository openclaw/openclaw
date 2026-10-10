import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  parseUpdateRecoveryBackupManifest,
  type UpdateRecoveryBackupManifest,
} from "../commands/backup-verify-manifest.js";
import { createDoctorRehearsalDatabaseCoverage } from "../commands/doctor-rehearsal-databases.js";
import { createConfigIO } from "../config/io.factory.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { PluginDoctorMigrationBackupWarning } from "../plugins/doctor-contract-module.js";
import { preparePluginDoctorMigrationBackupResources } from "../plugins/doctor-contract-registry.js";
import { ensurePrivateSnapshotRepositoryRoot } from "../snapshot/local-repository.js";
import { isOpenClawAgentDatabaseOpen } from "../state/openclaw-agent-db.js";
import { openClawStateDatabaseCache } from "../state/openclaw-state-db-cache.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  maintenanceOwnerHasSourceCustody,
} from "../state/openclaw-state-maintenance-context.js";
import { resolveBackupConfigCapture } from "./backup-config-capture.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256Hex } from "./crypto-digest.js";
import {
  pinDirectory,
  publishFileExclusive,
  requireDirectorySync,
  sha256File,
  syncDirectory,
} from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import {
  copyFileHandle,
  hashFileMutationSnapshotSync,
  sameFileMutationFingerprint,
  sameFileMutationMetadata,
} from "./file-descriptor.js";
import { root as safeRoot } from "./fs-safe.js";
import { SQLITE_SIDECAR_SUFFIXES } from "./sqlite-files.js";
import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";
import { readUpdateDatabaseGenerationsIsolated } from "./update-candidate-state.js";
import { isUpdateCapturePath, resolveUpdateCaptureRoot } from "./update-capture-paths.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "./update-capture-privacy-marker.js";
import { createUpdateDatabaseBackup } from "./update-database-backup.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";
import type { UpdateRecoveryCaptureAcquisition } from "./update-recovery-capture-acquisition.js";
import { hasPendingUpdateRecoverySeal } from "./update-recovery-capture-seal.js";
import { canonicalEntryPath } from "./update-recovery-path.js";
import { readUpdateRunDriver, type UpdateRunDriver } from "./update-run-driver.js";
import { getUpdateRunAsync } from "./update-run-reader.js";

declare const SEALED_RUNTIME_BUILD: boolean;

type Entry = UpdateRecoveryBackupManifest["entries"][number];
type ResourceKind = "file" | "directory" | "sqlite";
type CapturedPath = { stat?: BigIntStats; names?: string[]; target?: string };

function matchesCapturedStat(
  pathname: string,
  before: BigIntStats,
  current: BigIntStats,
  sha256?: string,
): boolean {
  return (
    sameFileMutationMetadata(before, current) &&
    (sameFileMutationFingerprint(before, current) ||
      (sha256 !== undefined && hashFileMutationSnapshotSync(pathname, before) === sha256))
  );
}

export type UpdateRecoveryBaselineRef = {
  directory: string;
  manifestPath: string;
  manifestSha256: string;
};

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

async function statOrMissing(value: string): Promise<BigIntStats | undefined> {
  try {
    return await fs.lstat(value, { bigint: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function markPrivateCapture(directory: string): Promise<void> {
  const marker = path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER);
  try {
    await using output = await fs.open(marker, "wx", 0o600);
    await output.writeFile(UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT);
    await output.sync();
  } catch (error) {
    if (!hasErrnoCode(error, "EEXIST")) {
      throw error;
    }
    const root = await safeRoot(directory, { symlinks: "reject", hardlinks: "reject" });
    if (
      (await root.readText(UPDATE_CAPTURE_PRIVACY_MARKER, { maxBytes: 128 })) !==
      UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT
    ) {
      throw new Error(`Private update capture marker changed: ${directory}`, { cause: error });
    }
  }
  requireDirectorySync(await syncDirectory(directory), "Private update capture marker");
}

function maintenanceOwnerMayReadGenerationsInProcess(
  sharedStatePath: string,
  databasePaths: ReadonlySet<string>,
): boolean {
  const scope = getOpenClawDatabaseMaintenanceScope();
  // An open process-local source handle requires a child: a raw close here could release its POSIX locks.
  return (
    maintenanceOwnerHasSourceCustody(scope, sharedStatePath) &&
    !openClawStateDatabaseCache.isOpenClawStateDatabaseOpen(sharedStatePath) &&
    [...databasePaths].every(
      (pathname) =>
        maintenanceOwnerHasSourceCustody(scope, pathname) && !isOpenClawAgentDatabaseOpen(pathname),
    )
  );
}

/** Capture for manual recovery under the original invocation's live custody.
 * Sources may remain active; final revalidation is not authority to restore them. */
export function captureUpdateRecoveryBaseline(params: {
  runId: string;
  installRoot: string;
  env: NodeJS.ProcessEnv;
  drivers: readonly UpdateRunDriver[];
  assertCurrent: () => void;
  signal?: AbortSignal;
  nodeRunner?: string;
  timeoutMs?: number;
  acquisition?: UpdateRecoveryCaptureAcquisition;
}) {
  // Sealed helpers consume retained evidence; the installed CLI owns fresh capture.
  if (typeof SEALED_RUNTIME_BUILD === "boolean" && SEALED_RUNTIME_BUILD) {
    throw new Error("Fresh original-state capture requires the installed CLI.");
  }
  return withArtifactPreservingStateReads(async () => {
    const runId = params.runId;
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(runId)) {
      throw new Error("Invalid original update capture run identity.");
    }
    const env = { ...params.env };
    const sharedStatePath = resolveOpenClawStateSqlitePath(env);
    const assertCaller = params.assertCurrent;
    const rehearsal = createDoctorRehearsalDatabaseCoverage(params.env);
    const assertCurrent = () => {
      params.signal?.throwIfAborted();
      assertCaller();
      rehearsal?.assertCurrent();
    };
    assertCurrent();
    const configIO = createConfigIO({
      env,
      configPath: resolveConfigPath(env),
      observe: false,
      pluginValidation: "core-only",
    });
    const configuration = await configIO.readConfigFileSnapshotForWrite();
    assertCurrent();
    const snapshot = configuration.snapshot;
    if (path.resolve(snapshot.path) !== path.resolve(resolveConfigPath(env))) {
      throw new Error("Original update capture changed its selected configuration path.");
    }
    if (snapshot.exists && snapshot.raw === null) {
      throw new Error("Original update configuration is unreadable.");
    }
    const configCapture = await resolveBackupConfigCapture(configuration, {
      env,
      pluginValidation: "core-only",
    });
    assertCurrent();
    const creator = readUpdateRunDriver();
    if (!creator) {
      throw new Error("Cannot identify the original update capture process.");
    }
    const stateDir = resolvePathViaExistingAncestorSync(resolveStateDir(env));
    const configPath = canonicalEntryPath(snapshot.path);
    const store = resolveUpdateCaptureRoot(stateDir);
    const directory = path.join(store, runId);
    const installRoot = path.resolve(params.installRoot);
    const drivers = structuredClone([...params.drivers]);
    const createdAt = new Date().toISOString();
    const configPaths = new Set([configPath]);
    const resources = new Map<string, ResourceKind>();
    const warnings: PluginDoctorMigrationBackupWarning[] = [];
    const declare = (pathname: string, kind: ResourceKind) => {
      const canonical = canonicalEntryPath(pathname);
      if (
        within(canonical, store) ||
        (kind === "directory" && within(store, canonical)) ||
        isUpdateCapturePath(canonical, stateDir)
      ) {
        throw new Error(`An original capture cannot contain another capture: ${canonical}`);
      }
      const previous = resources.get(canonical);
      if (previous && previous !== kind) {
        throw new Error(`Conflicting original update resource kinds: ${canonical}`);
      }
      resources.set(canonical, kind);
      return canonical;
    };
    declare(configPath, "file");
    for (const file of configCapture.files) {
      configPaths.add(declare(file.sourcePath, "file"));
      configPaths.add(declare(file.canonicalPath, "file"));
    }
    const collectResources = () =>
      withOpenClawStateDatabaseReadSnapshot(
        async () => {
          const plugins = await preparePluginDoctorMigrationBackupResources({
            config: snapshot.sourceConfig,
            env,
            stateDir,
            warnings,
            requireLocalResources: true,
          });
          plugins.assertCurrent();
          return plugins.resources;
        },
        { env },
      );
    const declared = await collectResources();
    assertCurrent();
    for (const resource of declared) {
      declare(resource.path, resource.kind);
    }
    await configCapture.revalidate();
    assertCurrent();

    const observed = new Map<string, CapturedPath>();
    const entries = new Map<string, Entry>();
    const files = new Map<string, BigIntStats>();
    const roots = new Set(resources.keys());
    const forcedSqlite = new Set<string>();
    const visit = async (pathname: string, declaredKind?: ResourceKind): Promise<void> => {
      const kind = declaredKind ?? resources.get(pathname);
      if (observed.has(pathname)) {
        return;
      }
      if (observed.size >= 1_000_000) {
        throw new Error("Original update resource inventory exceeds its manifest bound.");
      }
      assertCurrent();
      const stat = await statOrMissing(pathname);
      assertCurrent();
      observed.set(pathname, { stat });
      if (!stat) {
        if (kind === "sqlite") {
          forcedSqlite.add(pathname);
        }
        entries.set(pathname, {
          kind: "missing",
          sourcePath: pathname,
          sqlite: kind === "sqlite",
          directory: kind === "directory",
        });
        return;
      }
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(pathname);
        observed.set(pathname, { stat, target });
        const entry: Extract<Entry, { kind: "symlink" }> = {
          kind: "symlink",
          sourcePath: pathname,
          target,
        };
        entries.set(pathname, entry);
        if (kind) {
          const contentPath = await fs.realpath(pathname).catch((error: unknown) => {
            if (!hasErrnoCode(error, "ENOENT")) {
              throw error;
            }
            return canonicalEntryPath(path.resolve(path.dirname(pathname), target));
          });
          if (contentPath === pathname) {
            throw new Error(`Original update resource link is cyclic: ${pathname}`);
          }
          roots.add(contentPath);
          if (configPaths.has(pathname)) {
            entry.contentPath = contentPath;
            configPaths.add(contentPath);
          }
          await visit(contentPath, kind);
        }
        return;
      }
      if (kind === "sqlite") {
        forcedSqlite.add(pathname);
      }
      if (stat.isDirectory()) {
        if (isUpdateCapturePath(pathname, stateDir)) {
          throw new Error(`Original update resource contains a private capture: ${pathname}`);
        }
        if (kind && kind !== "directory") {
          throw new Error(`Original update resource is unexpectedly a directory: ${pathname}`);
        }
        const names = (await fs.readdir(pathname)).toSorted();
        observed.set(pathname, { stat, names });
        entries.set(pathname, {
          kind: "directory",
          sourcePath: pathname,
          mode: Number(stat.mode & 0o777n),
        });
        for (const name of names) {
          await visit(path.join(pathname, name));
        }
      } else if (stat.isFile() && kind !== "directory") {
        files.set(pathname, stat);
      } else {
        throw new Error(`Original update resource has an unsupported file kind: ${pathname}`);
      }
    };
    for (const [pathname, kind] of resources) {
      await visit(pathname, kind);
    }
    assertCurrent();
    await ensurePrivateSnapshotRepositoryRoot(store);
    await markPrivateCapture(store);
    assertCurrent();
    await createPrivateSqliteDirectory(directory);
    const pin = await pinDirectory(directory);
    try {
      await markPrivateCapture(directory);
      await createPrivateSqliteDirectory(path.join(directory, "payload"));
      requireDirectorySync(await syncDirectory(store), "Original update capture root");
      assertCurrent();
      const databases = await createUpdateDatabaseBackup({
        backupRoot: path.join(directory, "database"),
        stateDir,
        config: snapshot.sourceConfig,
        env,
        signal: params.signal,
        nodeRunner: params.nodeRunner,
        timeoutMs: params.timeoutMs,
        acquisition: params.acquisition,
        preserveSourceArtifacts: true,
        additionalPaths: [...forcedSqlite],
        additionalFiles: [...files.keys()].filter((pathname) => !configPaths.has(pathname)),
        rehearsal,
      });
      assertCurrent();
      const databasePaths = new Set([
        ...databases.databases.map((file) => file.path),
        ...databases.missingPaths,
      ]);
      const databaseSpellings = new Set([
        ...databasePaths,
        ...databases.sourcePaths.map(canonicalEntryPath),
      ]);
      const databaseOwners = databases.databaseOwners;
      if (!databaseOwners) {
        throw new Error("Original update database ownership inventory is unavailable.");
      }
      for (const pathname of [...databases.sourcePaths, ...databasePaths]) {
        const canonical = canonicalEntryPath(pathname);
        roots.add(canonical);
        await visit(canonical, "sqlite");
      }
      const sidecars = new Set(
        [...databaseSpellings].flatMap((file) =>
          SQLITE_SIDECAR_SUFFIXES.map((suffix) => file + suffix),
        ),
      );
      let payloadIndex = 0;
      for (const file of databases.databases) {
        const archivePath = `payload/${payloadIndex++}`;
        const payloadPath = path.join(directory, archivePath);
        const sourceIdentity = await fs.lstat(file.snapshotPath, { bigint: true });
        assertCurrent();
        await pin.assertCurrent();
        assertCurrent();
        const publication = await publishFileExclusive({
          sourcePath: file.snapshotPath,
          targetPath: payloadPath,
          expectedSourceIdentity: sourceIdentity,
          strategy: "rename-noreplace",
          onSyncFailure: "preserve",
        });
        assertCurrent();
        requireDirectorySync(publication.directorySync, "Original database payload publication");
        requireDirectorySync(
          await syncDirectory(path.dirname(file.snapshotPath)),
          "Original database snapshot removal",
        );
        assertCurrent();
        const content = await sha256File(payloadPath);
        if (content.digest !== file.sha256 || content.bytes !== file.sizeBytes) {
          throw new Error(`Original database payload changed: ${file.path}`);
        }
        const stat = files.get(file.path);
        if (!stat) {
          throw new Error(`Original database disappeared during capture: ${file.path}`);
        }
        entries.set(file.path, {
          kind: "file",
          sourcePath: file.path,
          archivePath,
          size: file.sizeBytes,
          sha256: file.sha256,
          sqlite: true,
          mode: Number(stat.mode & 0o777n),
        });
      }
      for (const [pathname, before] of files) {
        if (
          databaseSpellings.has(pathname) ||
          sidecars.has(pathname) ||
          rehearsal?.excludes(pathname)
        ) {
          continue;
        }
        assertCurrent();
        await pin.assertCurrent();
        assertCurrent();
        const sourceRoot = await safeRoot(path.dirname(pathname));
        assertCurrent();
        const source = await sourceRoot.open(path.basename(pathname), {
          symlinks: "reject",
          hardlinks: "allow",
        });
        const archivePath = `payload/${payloadIndex++}`;
        await using handle = source.handle;
        const opened = await handle.stat({ bigint: true });
        // Before the private copy exists, no content witness can admit timestamp drift.
        if (!matchesCapturedStat(pathname, before, opened)) {
          throw new Error(`Original update file changed before capture: ${pathname}`);
        }
        const sha256 = hashFileMutationSnapshotSync(pathname, opened);
        if (!matchesCapturedStat(pathname, opened, await handle.stat({ bigint: true }))) {
          throw new Error(`Original update file changed before capture: ${pathname}`);
        }
        assertCurrent();
        await using output = await fs.open(path.join(directory, archivePath), "wx+", 0o600);
        await copyFileHandle(handle, output, { assertBeforeMutation: assertCurrent });
        await output.sync();
        const content = await sha256File(output);
        if (
          content.digest !== sha256 ||
          !matchesCapturedStat(pathname, opened, await handle.stat({ bigint: true }), sha256)
        ) {
          throw new Error(`Original update file changed during capture: ${pathname}`);
        }
        entries.set(pathname, {
          kind: "file",
          sourcePath: pathname,
          archivePath,
          size: content.bytes,
          sha256: content.digest,
          sqlite: false,
          mode: Number(before.mode & 0o777n),
        });
      }
      await configCapture.revalidate();
      if (!isDeepStrictEqual(await collectResources(), declared)) {
        throw new Error("Original update migration resource inventory changed during capture.");
      }
      assertCurrent();
      const generations =
        params.acquisition?.mode === "maintenance-owner" &&
        maintenanceOwnerMayReadGenerationsInProcess(sharedStatePath, databasePaths)
          ? readUpdateDatabaseGenerations([...databasePaths])
          : await readUpdateDatabaseGenerationsIsolated([...databasePaths], {
              env,
              signal: params.signal,
              timeoutMs: params.timeoutMs,
              acquisition: params.acquisition,
            });
      if (
        [...databasePaths].some(
          (pathname) =>
            !Object.hasOwn(databases.sourceGenerations, pathname) ||
            databases.sourceGenerations[pathname] !== generations[pathname],
        )
      ) {
        throw new Error(
          "Original database generation changed or could not be verified; capture is unsealed.",
        );
      }
      for (const [pathname, before] of observed) {
        if (databaseSpellings.has(pathname) || sidecars.has(pathname)) {
          continue;
        }
        const current = await statOrMissing(pathname);
        const entry = entries.get(pathname);
        const sha256 = entry?.kind === "file" && !entry.sqlite ? entry.sha256 : undefined;
        if (
          before.stat
            ? !current || !matchesCapturedStat(pathname, before.stat, current, sha256)
            : current !== undefined
        ) {
          throw new Error(`Original update resource changed during capture: ${pathname}`);
        }
        if (
          before.names &&
          !isDeepStrictEqual((await fs.readdir(pathname)).toSorted(), before.names)
        ) {
          throw new Error(`Original update directory changed during capture: ${pathname}`);
        }
        if (before.target !== undefined && (await fs.readlink(pathname)) !== before.target) {
          throw new Error(`Original update resource link changed during capture: ${pathname}`);
        }
      }
      const boundedWarnings = warnings.slice(0, 32).map((warning) => ({
        kind: warning.kind,
        pluginId: warning.pluginId,
        message: truncateUtf16Safe(warning.message, 500),
      }));
      const manifest: UpdateRecoveryBackupManifest = {
        schemaVersion: 2,
        kind: "update-recovery",
        generation: { kind: "baseline" },
        runId,
        installRoot,
        stateDir,
        configPath,
        configPaths: [...configPaths].toSorted(),
        creator,
        drivers,
        createdAt,
        roots: [...roots].filter((pathname) => !rehearsal?.excludes(pathname)).toSorted(),
        excludedRoots: [
          ...new Set([
            ...(rehearsal?.paths ?? []),
            ...[...observed.keys()].filter((pathname) => rehearsal?.excludes(pathname)),
          ]),
        ].toSorted(),
        protectedPaths: [...resources.keys()]
          .filter((pathname) => !rehearsal?.excludes(pathname))
          .toSorted(),
        databases: databaseOwners,
        entries: [...entries.values()]
          .filter(
            (entry) => !sidecars.has(entry.sourcePath) && !rehearsal?.excludes(entry.sourcePath),
          )
          .toSorted((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
        ...(boundedWarnings.length ? { warnings: boundedWarnings } : {}),
      };
      const raw = `${JSON.stringify(manifest)}\n`;
      if (Buffer.byteLength(raw) > 128 * 1024 * 1024) {
        throw new Error("Original update capture exceeds its manifest size bound.");
      }
      parseUpdateRecoveryBackupManifest(raw);
      assertCurrent();
      await pin.assertCurrent();
      requireDirectorySync(
        await syncDirectory(path.join(directory, "payload")),
        "Original update payloads",
      );
      const manifestPath = path.join(directory, "manifest.json");
      const temporaryManifestPath = path.join(directory, "manifest.json.partial");
      let manifestIdentity: BigIntStats;
      {
        assertCurrent();
        await using output = await fs.open(temporaryManifestPath, "wx", 0o600);
        assertCurrent();
        await output.writeFile(raw);
        assertCurrent();
        await output.sync();
        manifestIdentity = await output.stat({ bigint: true });
      }
      await pin.assertCurrent();
      assertCurrent();
      const publication = await publishFileExclusive({
        sourcePath: temporaryManifestPath,
        targetPath: manifestPath,
        expectedSourceIdentity: manifestIdentity,
        parentReceipt: pin.receipt,
        strategy: "rename-noreplace",
        onSyncFailure: "preserve",
      });
      requireDirectorySync(publication.directorySync, "Original update capture seal");
      assertCurrent();
      return {
        ref: {
          directory,
          manifestPath,
          manifestSha256: sha256Hex(raw),
        } satisfies UpdateRecoveryBaselineRef,
        warnings: boundedWarnings,
        diagnostics: { databaseWarnings: databases.warnings },
      };
    } catch (cause) {
      throw new Error(`Original update capture failed; evidence retained at ${directory}`, {
        cause,
      });
    } finally {
      await pin.close();
    }
  });
}

const STANDALONE_DOCTOR_CAPTURE_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Only sealed, unassociated standalone originals are eligible for retirement. */
export async function retireExpiredStandaloneDoctorCaptures(params: {
  stateDir: string;
  keepRunId: string;
  now?: number;
  assertCurrent: () => void;
}): Promise<{ retired: string[]; warnings: string[] }> {
  const retired: string[] = [];
  const warnings: string[] = [];
  const root = resolveUpdateCaptureRoot(params.stateDir);
  const now = params.now ?? Date.now();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      warnings.push(
        `Standalone Doctor capture retirement unavailable at ${root}: ${formatErrorMessage(error)}`,
      );
    }
    return { retired, warnings };
  }
  for (const name of names.toSorted()) {
    if (
      name === params.keepRunId ||
      !/^doctor-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(name)
    ) {
      continue;
    }
    const directory = path.join(root, name);
    try {
      const entry = await fs.lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      if (
        (await hasPendingUpdateRecoverySeal(directory)) ||
        !(await statOrMissing(path.join(directory, "manifest.json")))
      ) {
        continue;
      }
      const source = await safeRoot(directory, { symlinks: "reject", hardlinks: "reject" });
      const manifest = parseUpdateRecoveryBackupManifest(
        await source.readText("manifest.json", { maxBytes: 128 * 1024 * 1024 }),
      );
      const createdAt = Date.parse(manifest.createdAt);
      if (
        manifest.runId !== name ||
        manifest.schemaVersion !== 2 ||
        manifest.generation?.kind !== "baseline" ||
        !Number.isFinite(createdAt) ||
        now - createdAt <= STANDALONE_DOCTOR_CAPTURE_RETENTION_MS ||
        (await statOrMissing(path.join(directory, "outcome.json"))) ||
        (await getUpdateRunAsync(manifest.runId, {
          path: path.join(params.stateDir, "state", "openclaw.sqlite"),
        })) !== undefined
      ) {
        continue;
      }
      if (await hasPendingUpdateRecoverySeal(directory)) {
        continue;
      }
      params.assertCurrent();
      await fs.rm(directory, { recursive: true });
      retired.push(directory);
    } catch (error) {
      warnings.push(
        `Standalone Doctor capture retained at ${directory}: ${formatErrorMessage(error)}`,
      );
    }
  }
  return { retired, warnings };
}
