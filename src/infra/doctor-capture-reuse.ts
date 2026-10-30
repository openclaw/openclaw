import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parseUpdateRecoveryBackupManifest,
  type UpdateRecoveryBackupManifest,
} from "../commands/backup-verify-manifest.js";
import { createConfigIO } from "../config/io.factory.js";
import { resolveConfigPath } from "../config/paths.js";
import type { PluginDoctorMigrationBackupWarning } from "../plugins/doctor-contract-module.js";
import { preparePluginDoctorMigrationBackupResources } from "../plugins/doctor-contract-registry.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import { resolveBackupConfigCapture } from "./backup-config-capture.js";
import { sha256Hex } from "./crypto-digest.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import { sha256File } from "./directory-durability.js";
import { collectStandaloneDoctorCaptures } from "./doctor-capture-retention.js";
import { ignoreMissingPath } from "./errno.js";
import { sameFileMutationFingerprint } from "./file-descriptor.js";
import { root as safeRoot } from "./fs-safe.js";
import { SQLITE_SIDECAR_SUFFIXES } from "./sqlite-files.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import { resolveSqliteInspectionBudget } from "./sqlite-readonly-worker.js";
import { createSqliteSnapshotStagingDirectory } from "./sqlite-snapshot-staging.js";
import { withStateInspectionCleanup } from "./update-candidate-state.process.js";
import { resolveUpdateCaptureRoot } from "./update-capture-paths.js";
import { createUpdateDatabaseBackup } from "./update-database-backup.js";
import { withVerifiedUpdateRecoveryBackup } from "./update-recovery-backup-reader.js";
import type { UpdateRecoveryBaselineRef } from "./update-recovery-baseline-capture.js";
import { canonicalEntryPath } from "./update-recovery-path.js";

type ResourceKind = "file" | "directory" | "sqlite";
type ReuseOptions = {
  stateDir: string;
  installRoot: string;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
  signal?: AbortSignal;
};

// These are optimization budgets, never capture/update admission limits. An
// incomplete comparison simply takes the existing fresh-capture path.
const MAX_REUSE_ENTRIES = 4096;

/** Equality is content and inventory, not the age, size, or mtime of a capture. */
export async function findReusableDoctorCapture(
  params: ReuseOptions,
): Promise<UpdateRecoveryBaselineRef | undefined> {
  let deadline =
    performance.now() +
    resolveSqliteInspectionBudget("Doctor capture comparison", params.stateDir, 0).timeoutMs;
  const check = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
    if (performance.now() > deadline) {
      throw new Error("Standalone Doctor capture comparison exceeded its reuse budget.");
    }
  };
  try {
    return await withArtifactPreservingStateReads(async () => {
      check();
      // Do not prepare shared-state bytes when there is no retained capture to compare.
      const root = await fs
        .lstat(resolveUpdateCaptureRoot(params.stateDir))
        .catch(ignoreMissingPath);
      if (!root?.isDirectory()) {
        return undefined;
      }
      // The collector reads recovery/update ledgers synchronously. Prepare its
      // private view asynchronously so large sources remain cancellable here too.
      const { captures, warnings } = await withOpenClawStateDatabaseReadSnapshot(
        async () => collectStandaloneDoctorCaptures(params),
        { env: params.env, signal: params.signal },
      );
      if (warnings.length) {
        return undefined;
      }
      const [newest] = [...captures].toSorted(([, a], [, b]) => b.createdAt - a.createdAt);
      if (!newest || newest[1].reason === "pending-update-recovery") {
        return undefined;
      }
      const [directory] = newest;
      const source = await safeRoot(directory, { symlinks: "reject", hardlinks: "reject" });
      const raw = await source.readText("manifest.json", { maxBytes: 8 * 1024 * 1024 });
      const preview = parseUpdateRecoveryBackupManifest(raw);
      if (preview.entries.length > MAX_REUSE_ENTRIES) {
        return undefined;
      }
      // Large originals are the reason to reuse, not a reason to allocate another
      // full copy. Stream their digests with the existing size-aware I/O allowance.
      const bytes = preview.entries.reduce(
        (total, entry) => total + (entry.kind === "file" ? entry.size : 0),
        0,
      );
      deadline =
        performance.now() +
        resolveSqliteInspectionBudget("Doctor capture comparison", directory, bytes).timeoutMs;
      // Refuse oversized or replaced payloads before the existing verifier
      // streams them. Its own digest proof remains mandatory for every reuse.
      for (const entry of preview.entries) {
        check();
        if (entry.kind === "file") {
          const stat = await fs.lstat(path.join(directory, entry.archivePath));
          if (!stat.isFile() || stat.size !== entry.size) {
            return undefined;
          }
        }
      }
      const ref = {
        directory,
        manifestPath: path.join(directory, "manifest.json"),
        manifestSha256: sha256Hex(raw),
      };
      return await withVerifiedUpdateRecoveryBackup(ref, async (manifest) => {
        check();
        if (
          manifest.runId !== path.basename(directory) ||
          manifest.generation?.kind !== "baseline" ||
          manifest.installRoot !== path.resolve(params.installRoot) ||
          manifest.stateDir !== params.stateDir ||
          manifest.configPath !== canonicalEntryPath(resolveConfigPath(params.env)) ||
          manifest.excludedRoots.length ||
          manifest.warnings?.length
        ) {
          return undefined;
        }
        for (const name of ["outcome.json", "candidate", "prepared"]) {
          if (await fs.lstat(path.join(directory, name)).catch(ignoreMissingPath)) {
            return undefined;
          }
        }
        await compareCurrentSources(manifest, params, check);
        check();
        return ref;
      });
    });
  } catch (error) {
    // Revoked maintenance and unjoined readers still belong to their caller;
    // unavailable evidence or exhausted comparison budgets are just cache misses.
    params.assertCurrent();
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    params.signal?.throwIfAborted();
    return undefined;
  }
}

async function compareCurrentSources(
  manifest: UpdateRecoveryBackupManifest,
  params: ReuseOptions,
  check: () => void,
): Promise<void> {
  const changed = () => new Error("Standalone Doctor original sources are not proven unchanged.");
  const configuration = await createConfigIO({
    env: params.env,
    configPath: resolveConfigPath(params.env),
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshotForWrite();
  check();
  // An anchor digest cannot prove external PostgreSQL contents. Rehearsal
  // exclusions and unknown plugin coverage likewise need a fresh capture.
  if (
    Object.values(resolveDatabaseFamilyEngines(configuration.snapshot.sourceConfig)).includes(
      "postgres",
    )
  ) {
    throw changed();
  }
  const config = await resolveBackupConfigCapture(configuration, {
    env: params.env,
    pluginValidation: "core-only",
  });
  const configPaths = new Set([manifest.configPath]);
  const resources = new Map<string, ResourceKind>([[manifest.configPath, "file"]]);
  const declare = (pathname: string, kind: ResourceKind) => {
    const canonical = canonicalEntryPath(pathname);
    if (resources.has(canonical) && resources.get(canonical) !== kind) {
      throw changed();
    }
    resources.set(canonical, kind);
    return canonical;
  };
  for (const file of config.files) {
    configPaths.add(declare(file.sourcePath, "file"));
    configPaths.add(declare(file.canonicalPath, "file"));
  }
  const warnings: PluginDoctorMigrationBackupWarning[] = [];
  const plugins = await withOpenClawStateDatabaseReadSnapshot(
    () =>
      preparePluginDoctorMigrationBackupResources({
        config: configuration.snapshot.sourceConfig,
        stateDir: params.stateDir,
        env: params.env,
        warnings,
        requireLocalResources: true,
      }),
    { env: params.env, signal: params.signal },
  );
  plugins.assertCurrent();
  check();
  if (warnings.length || plugins.deferredPluginIds.size) {
    throw changed();
  }
  for (const resource of plugins.resources) {
    declare(resource.path, resource.kind);
  }
  if (!isDeepStrictEqual([...resources.keys()].toSorted(), manifest.protectedPaths)) {
    throw changed();
  }

  // Rediscovery includes configured, on-disk, registered, and retained plugin
  // databases. Reading only yesterday's roots would miss a newly created store.
  const databaseSourceStats = new Map<string, BigIntStats | undefined>();
  for (const entry of manifest.entries) {
    if (entry.kind === "file" && entry.sqlite) {
      databaseSourceStats.set(
        entry.sourcePath,
        await fs.lstat(entry.sourcePath, { bigint: true }).catch(ignoreMissingPath),
      );
    }
  }
  const stagingRoot = await createSqliteSnapshotStagingDirectory(
    resolvePrivateSqliteSnapshotStagingRoot(params.env),
    false,
    params.signal,
  );
  const sqliteImages = await withStateInspectionCleanup(stagingRoot, () =>
    createUpdateDatabaseBackup({
      backupRoot: path.join(stagingRoot, "comparison"),
      stateDir: params.stateDir,
      config: configuration.snapshot.sourceConfig,
      env: params.env,
      signal: params.signal,
      acquisition: { mode: "maintenance-owner" },
      purpose: "original-state",
      preserveSourceArtifacts: true,
      integrityCheck: "quick",
      additionalPaths: [...resources].filter(([, kind]) => kind === "sqlite").map(([file]) => file),
      additionalFiles: manifest.entries.flatMap((entry) =>
        entry.kind === "file" && !configPaths.has(entry.sourcePath) ? [entry.sourcePath] : [],
      ),
      retryAdvice: false,
    }),
  );
  check();
  const roots = new Set(resources.keys());
  const databasePaths = new Set([
    ...sqliteImages.sourcePaths.map(canonicalEntryPath),
    ...sqliteImages.databases.map((file) => file.path),
    ...sqliteImages.missingPaths,
  ]);
  if (!isDeepStrictEqual(sqliteImages.databaseOwners, manifest.databases)) {
    throw changed();
  }
  const entries = new Map(manifest.entries.map((entry) => [entry.sourcePath, entry]));
  const sqlitePaths = new Set([
    ...databasePaths,
    ...manifest.entries
      .filter((entry) => (entry.kind === "file" || entry.kind === "missing") && entry.sqlite)
      .map((entry) => entry.sourcePath),
  ]);
  const sidecars = new Set(
    [...sqlitePaths].flatMap((file) => SQLITE_SIDECAR_SUFFIXES.map((suffix) => file + suffix)),
  );
  const matchesSqliteImage = (pathname: string, size: number, digest: string) => {
    const image = sqliteImages.databases.find((file) => file.path === pathname);
    return image?.sizeBytes === size && image.sha256 === digest;
  };
  const observed = new Map<string, BigIntStats | undefined>();
  const inspect = async (pathname: string, declaredKind?: ResourceKind): Promise<void> => {
    check();
    const kind = declaredKind ?? resources.get(pathname);
    if (observed.has(pathname)) {
      return;
    }
    const entry = entries.get(pathname);
    if (!entry || observed.size >= MAX_REUSE_ENTRIES) {
      throw changed();
    }
    const stat = await fs.lstat(pathname, { bigint: true }).catch(ignoreMissingPath);
    observed.set(pathname, stat);
    if (!stat) {
      if (
        entry.kind !== "missing" ||
        entry.sqlite !== (kind === "sqlite") ||
        entry.directory !== (kind === "directory")
      ) {
        throw changed();
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      if (entry.kind !== "symlink" || entry.target !== (await fs.readlink(pathname))) {
        throw changed();
      }
      if (kind) {
        const target = await fs.realpath(pathname).catch((error: unknown) => {
          ignoreMissingPath(error);
          return canonicalEntryPath(path.resolve(path.dirname(pathname), entry.target));
        });
        roots.add(target);
        if (configPaths.has(pathname)) {
          configPaths.add(target);
          if (entry.contentPath !== target) {
            throw changed();
          }
        }
        await inspect(target, kind);
      }
      return;
    }
    if (stat.isDirectory()) {
      if (
        entry.kind !== "directory" ||
        (kind && kind !== "directory") ||
        entry.mode !== Number(stat.mode & 0o777n)
      ) {
        throw changed();
      }
      const directory = await fs.opendir(pathname);
      for await (const child of directory) {
        const childPath = path.join(pathname, child.name);
        if (!sidecars.has(childPath)) {
          await inspect(childPath);
        }
      }
      return;
    }
    if (
      !stat.isFile() ||
      entry.kind !== "file" ||
      kind === "directory" ||
      (kind === "sqlite" && !entry.sqlite) ||
      entry.mode !== Number(stat.mode & 0o777n) ||
      entry.size !== Number(stat.size)
    ) {
      throw changed();
    }
    if (entry.sqlite) {
      roots.add(pathname);
      const beforeImage = databaseSourceStats.get(pathname);
      if (
        !beforeImage ||
        !sameFileMutationFingerprint(beforeImage, stat) ||
        !matchesSqliteImage(pathname, entry.size, entry.sha256)
      ) {
        throw changed();
      }
      return;
    }
    const source = await (
      await safeRoot(path.dirname(pathname))
    ).open(path.basename(pathname), {
      symlinks: "reject",
      hardlinks: "allow",
    });
    await using handle = source.handle;
    if (!sameFileMutationFingerprint(stat, await handle.stat({ bigint: true }))) {
      throw changed();
    }
    const digest = await sha256File(handle, { maxBytes: entry.size });
    if (
      digest.bytes !== entry.size ||
      digest.digest !== entry.sha256 ||
      !sameFileMutationFingerprint(stat, await handle.stat({ bigint: true }))
    ) {
      throw changed();
    }
  };
  for (const [pathname, kind] of resources) {
    await inspect(pathname, kind);
  }
  for (const pathname of databasePaths) {
    roots.add(pathname);
    await inspect(pathname, "sqlite");
  }
  if (
    observed.size !== entries.size ||
    !isDeepStrictEqual([...roots].toSorted(), manifest.roots) ||
    !isDeepStrictEqual([...configPaths].toSorted(), manifest.configPaths)
  ) {
    throw changed();
  }
  await config.revalidate();
  plugins.assertCurrent();
  // Compare exactly the same consolidated image format used by capture. WAL
  // mode changes header bytes during private normalization even without data
  // changes; never mask those bytes or compare only logical rows. Still reject
  // durable sidecar content. SHM is a disposable index, not data.
  for (const pathname of sqlitePaths) {
    for (const suffix of ["-wal", "-journal"]) {
      const stat = await fs.lstat(pathname + suffix).catch(ignoreMissingPath);
      if (stat && (!stat.isFile() || stat.size !== 0)) {
        throw changed();
      }
    }
  }
  // These fingerprints prove stability during this comparison only; they are
  // never substituted for a content witness across Doctor invocations.
  for (const [pathname, before] of observed) {
    check();
    const after = await fs.lstat(pathname, { bigint: true }).catch(ignoreMissingPath);
    if (
      before
        ? !after || !sameFileMutationFingerprint(before, after) || before.mode !== after.mode
        : after
    ) {
      throw changed();
    }
  }
}
