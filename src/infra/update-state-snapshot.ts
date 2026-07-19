import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigPath } from "../config/paths.js";
import { resolveStateDir } from "../config/paths.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import type { CommandRunner } from "./update-global.js";

const UPDATE_STATE_SNAPSHOT_DIRNAME = ".openclaw-previous-state";
const UPDATE_STATE_SNAPSHOT_MANIFEST = "update-state-snapshot.json";

export type UpdateStateSnapshotStrategy = "apfs-clone" | "reflink" | "sqlite-vacuum";

export type UpdateStateSnapshot = {
  version: 1;
  root: string;
  stateDir: string;
  requestedConfigPath: string;
  configPath: string;
  configSymlinkTarget: string | null;
  strategy: UpdateStateSnapshotStrategy;
  databases: string[];
  excludedStatePaths: string[];
  configDisposition: "state" | "external-present" | "external-absent";
  configSnapshot: string | null;
};

type SnapshotManifest = Omit<UpdateStateSnapshot, "root">;

type UpdateStateSnapshotDeps = {
  platform: NodeJS.Platform;
  runCommand: CommandRunner;
  vacuumDatabase: (sourcePath: string, targetPath: string) => Promise<void>;
};

const SQLITE_FILE_HEADER = Buffer.from("SQLite format 3\0", "ascii");

async function hasSqliteFileHeader(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const header = Buffer.alloc(SQLITE_FILE_HEADER.length);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === header.length && header.equals(SQLITE_FILE_HEADER);
  } finally {
    await handle.close();
  }
}

function isDatabaseFileOrSidecar(filePath: string, databases: ReadonlySet<string>): boolean {
  if (databases.has(filePath)) {
    return true;
  }
  for (const databasePath of databases) {
    if (!filePath.startsWith(`${databasePath}-`)) {
      continue;
    }
    const suffix = filePath.slice(databasePath.length + 1);
    if (/^(?:wal|shm|journal|mj[\da-f]+)$/iu.test(suffix)) {
      return true;
    }
  }
  return false;
}

function isWithinPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 && !path.isAbsolute(value) && isWithinPath("/snapshot", `/snapshot/${value}`)
  );
}

function isExcludedStatePath(
  root: string,
  candidate: string,
  excluded: readonly string[],
): boolean {
  return excluded.some((relativePath) => isWithinPath(path.join(root, relativePath), candidate));
}

async function listDatabasePaths(
  root: string,
  excluded: readonly string[] = [],
): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (isExcludedStatePath(root, entryPath, excluded)) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && (await hasSqliteFileHeader(entryPath))) {
        result.push(entryPath);
      }
    }
  };
  await visit(root);
  return result.toSorted();
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function lstatOrNull(
  targetPath: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function preserveCopiedModes(source: string, target: string): Promise<void> {
  const [sourceStat, targetStat] = await Promise.all([fs.lstat(source), fs.lstat(target)]);
  if (sourceStat.isSymbolicLink() || targetStat.isSymbolicLink()) {
    return;
  }
  if (sourceStat.isDirectory() && targetStat.isDirectory()) {
    for (const entry of await fs.readdir(target)) {
      await preserveCopiedModes(path.join(source, entry), path.join(target, entry));
    }
  }
  // fs.cp creates directories through the process umask on some platforms.
  // Snapshot rollback must reproduce the original access boundary exactly.
  await fs.chmod(target, sourceStat.mode & 0o777);
}

async function assertSnapshotCoversStateSymlinks(params: {
  stateDir: string;
  configPath: string;
  excludedStatePaths: readonly string[];
}): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (isExcludedStatePath(params.stateDir, entryPath, params.excludedStatePaths)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        const target = path.resolve(await fs.realpath(entryPath));
        const targetCovered =
          isWithinPath(params.stateDir, target) &&
          !isExcludedStatePath(params.stateDir, target, params.excludedStatePaths);
        // A separately captured config target is the only covered exception.
        if (!targetCovered && target !== params.configPath) {
          throw new Error(`state symlink escapes rollback snapshot: ${entryPath}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
      }
    }
  };
  await visit(params.stateDir);
}

async function writeManifest(root: string, manifest: SnapshotManifest): Promise<void> {
  await fs.writeFile(
    path.join(root, UPDATE_STATE_SNAPSHOT_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** Load and validate the durable manifest used by interrupted-update recovery. */
export async function readUpdateStateSnapshot(root: string): Promise<UpdateStateSnapshot> {
  const canonicalRoot = path.resolve(root);
  const raw = JSON.parse(
    await fs.readFile(path.join(canonicalRoot, UPDATE_STATE_SNAPSHOT_MANIFEST), "utf8"),
  ) as Partial<SnapshotManifest>;
  if (
    raw.version !== 1 ||
    typeof raw.stateDir !== "string" ||
    typeof raw.requestedConfigPath !== "string" ||
    typeof raw.configPath !== "string" ||
    (raw.configSymlinkTarget !== null && typeof raw.configSymlinkTarget !== "string") ||
    !["apfs-clone", "reflink", "sqlite-vacuum"].includes(raw.strategy ?? "") ||
    !Array.isArray(raw.databases) ||
    raw.databases.some((entry) => typeof entry !== "string" || !isSafeRelativePath(entry)) ||
    !Array.isArray(raw.excludedStatePaths) ||
    raw.excludedStatePaths.some(
      (entry) => typeof entry !== "string" || !isSafeRelativePath(entry),
    ) ||
    !["state", "external-present", "external-absent"].includes(raw.configDisposition ?? "") ||
    (raw.configSnapshot !== null &&
      (typeof raw.configSnapshot !== "string" || !isSafeRelativePath(raw.configSnapshot))) ||
    (raw.configDisposition === "external-present" && raw.configSnapshot === null) ||
    (raw.configDisposition !== "external-present" && raw.configSnapshot !== null)
  ) {
    throw new Error(`invalid update state snapshot manifest: ${canonicalRoot}`);
  }
  return {
    version: 1,
    root: canonicalRoot,
    stateDir: path.resolve(raw.stateDir),
    requestedConfigPath: path.resolve(raw.requestedConfigPath),
    configPath: path.resolve(raw.configPath),
    configSymlinkTarget: raw.configSymlinkTarget,
    strategy: raw.strategy,
    databases: raw.databases,
    excludedStatePaths: raw.excludedStatePaths,
    configDisposition: raw.configDisposition,
    configSnapshot: raw.configSnapshot,
  } as UpdateStateSnapshot;
}

async function copyConfig(params: {
  configPath: string;
  snapshotRoot: string;
}): Promise<string | null> {
  if (!(await exists(params.configPath))) {
    return null;
  }
  const relativePath = path.join("config", "openclaw.json");
  const targetPath = path.join(params.snapshotRoot, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  await fs.copyFile(params.configPath, targetPath);
  return relativePath;
}

async function tryCloneState(params: {
  deps: UpdateStateSnapshotDeps;
  stateDir: string;
  snapshotStateRoot: string;
  timeoutMs: number;
}): Promise<UpdateStateSnapshotStrategy | null> {
  const argv =
    params.deps.platform === "darwin"
      ? ["/bin/cp", "-cR", params.stateDir, params.snapshotStateRoot]
      : ["cp", "--reflink=always", "-a", params.stateDir, params.snapshotStateRoot];
  const result = await params.deps.runCommand(argv, {
    cwd: path.dirname(params.snapshotStateRoot),
    timeoutMs: params.timeoutMs,
  });
  if (result.code !== 0 || !(await exists(params.snapshotStateRoot))) {
    await fs.rm(params.snapshotStateRoot, { recursive: true, force: true });
    return null;
  }
  return params.deps.platform === "darwin" ? "apfs-clone" : "reflink";
}

/** Snapshot mutable state beside the retained package without modifying live state. */
export async function createUpdateStateSnapshot(params: {
  retainedPackageRoot: string;
  currentPackageRoot: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  configPath?: string;
  timeoutMs: number;
  runCommand: CommandRunner;
  platform?: NodeJS.Platform;
  vacuumDatabase?: (sourcePath: string, targetPath: string) => Promise<void>;
}): Promise<UpdateStateSnapshot> {
  const env = params.env ?? process.env;
  const requestedStateDir = path.resolve(params.stateDir ?? resolveStateDir(env));
  // Clone the canonical directory contents. A command-line symlink can otherwise
  // be preserved as a live link, making the backup mutate with the source.
  const stateDir = path.resolve(await fs.realpath(requestedStateDir));
  const requestedConfigPath = path.resolve(params.configPath ?? resolveConfigPath(env));
  const requestedConfigStat = await lstatOrNull(requestedConfigPath);
  const configSymlinkTarget = requestedConfigStat?.isSymbolicLink()
    ? await fs.readlink(requestedConfigPath)
    : null;
  // Restore through the canonical target. Replacing a configured symlink would
  // silently detach centrally managed configuration from its owner.
  const configPath = configSymlinkTarget
    ? (await exists(requestedConfigPath))
      ? path.resolve(await fs.realpath(requestedConfigPath))
      : path.resolve(path.dirname(requestedConfigPath), configSymlinkTarget)
    : requestedConfigPath;
  const currentPackageRoot = path.resolve(await fs.realpath(params.currentPackageRoot));
  if (isWithinPath(currentPackageRoot, stateDir)) {
    throw new Error("OpenClaw state directory cannot be inside the managed package root");
  }
  const installOwnerRoot = path.resolve(
    await fs.realpath(path.dirname(path.resolve(params.retainedPackageRoot))),
  );
  const finalRoot = path.join(installOwnerRoot, UPDATE_STATE_SNAPSHOT_DIRNAME);
  const excludedStatePaths = isWithinPath(stateDir, installOwnerRoot)
    ? [path.relative(stateDir, installOwnerRoot)]
    : [];
  if (excludedStatePaths.includes("")) {
    throw new Error("managed install root cannot equal the OpenClaw state directory");
  }
  await assertSnapshotCoversStateSymlinks({
    stateDir,
    configPath,
    excludedStatePaths,
  });
  // Capture directly into a same-filesystem rename stage. A second ordinary
  // copy would discard APFS clone/reflink space guarantees. When the managed
  // install lives inside state, stage beside state to avoid copying a source
  // directory into itself; the final rename remains on the same filesystem.
  const stageParent = isWithinPath(stateDir, installOwnerRoot)
    ? path.dirname(stateDir)
    : installOwnerRoot;
  const stageRoot = path.join(
    stageParent,
    `.${path.basename(finalRoot)}.stage-${process.pid}-${Date.now()}`,
  );
  const snapshotStateRoot = path.join(stageRoot, "state");
  const deps: UpdateStateSnapshotDeps = {
    platform: params.platform ?? process.platform,
    runCommand: params.runCommand,
    vacuumDatabase:
      params.vacuumDatabase ??
      (async (sourcePath, targetPath) => {
        await createVerifiedSqliteSnapshot({ sourcePath, targetPath });
      }),
  };

  await fs.rm(finalRoot, { recursive: true, force: true });
  await fs.rm(stageRoot, { recursive: true, force: true });
  await fs.mkdir(stageRoot, { recursive: true, mode: 0o700 });
  try {
    let strategy = await tryCloneState({
      deps,
      stateDir,
      snapshotStateRoot,
      timeoutMs: params.timeoutMs,
    });
    let databases: string[];
    if (strategy) {
      for (const relativePath of excludedStatePaths) {
        await fs.rm(path.join(snapshotStateRoot, relativePath), {
          recursive: true,
          force: true,
        });
      }
      databases = (await listDatabasePaths(stateDir, excludedStatePaths)).map((databasePath) =>
        path.relative(stateDir, databasePath),
      );
    } else {
      strategy = "sqlite-vacuum";
      const liveDatabases = await listDatabasePaths(stateDir, excludedStatePaths);
      const liveDatabaseSet = new Set(liveDatabases);
      databases = liveDatabases.map((databasePath) => path.relative(stateDir, databasePath));
      // Preserve the complete state tree while SQLite files receive consistent
      // VACUUM snapshots. Replacing this tree on rollback also removes paths
      // created by the candidate version.
      await fs.cp(stateDir, snapshotStateRoot, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
        filter: async (source) => {
          if (source === stateDir) {
            return true;
          }
          if (isExcludedStatePath(stateDir, source, excludedStatePaths)) {
            return false;
          }
          const sourceStat = await fs.lstat(source);
          return !sourceStat.isFile() || !isDatabaseFileOrSidecar(source, liveDatabaseSet);
        },
      });
      for (let index = 0; index < liveDatabases.length; index += 1) {
        const targetPath = path.join(snapshotStateRoot, databases[index]!);
        await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
        await deps.vacuumDatabase(liveDatabases[index]!, targetPath);
      }
    }
    await preserveCopiedModes(stateDir, snapshotStateRoot);

    const configInState = isWithinPath(stateDir, configPath);
    const configCoveredByStateSnapshot =
      configInState && !isExcludedStatePath(stateDir, configPath, excludedStatePaths);
    const configExists = await exists(configPath);
    const configDisposition = configCoveredByStateSnapshot
      ? "state"
      : configExists
        ? "external-present"
        : "external-absent";
    const configSnapshot =
      configDisposition === "external-present"
        ? await copyConfig({ configPath, snapshotRoot: stageRoot })
        : null;
    const manifest: SnapshotManifest = {
      version: 1,
      stateDir,
      requestedConfigPath,
      configPath,
      configSymlinkTarget,
      strategy,
      databases,
      excludedStatePaths,
      configDisposition,
      configSnapshot,
    };
    await writeManifest(stageRoot, manifest);
    await fs.rm(finalRoot, { recursive: true, force: true });
    await fs.rename(stageRoot, finalRoot);
    return { ...manifest, root: finalRoot };
  } catch (error) {
    await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function copySnapshotEntryAtomically(
  source: string,
  target: string,
  preserveTargetPaths: readonly string[],
): Promise<void> {
  const sourceStat = await fs.lstat(source);
  if (sourceStat.isDirectory()) {
    const targetStat = await lstatOrNull(target);
    if (targetStat && !targetStat.isDirectory()) {
      await fs.rm(target, { recursive: true, force: true });
    }
    await fs.mkdir(target, { recursive: true, mode: sourceStat.mode & 0o777 });
    const sourceEntries = await fs.readdir(source);
    for (const entry of sourceEntries.toSorted()) {
      await copySnapshotEntryAtomically(
        path.join(source, entry),
        path.join(target, entry),
        preserveTargetPaths,
      );
    }
    const sourceNames = new Set(sourceEntries);
    for (const entry of await fs.readdir(target)) {
      if (!sourceNames.has(entry)) {
        const targetEntry = path.join(target, entry);
        if (preserveTargetPaths.some((preserved) => isWithinPath(targetEntry, preserved))) {
          continue;
        }
        await fs.rm(targetEntry, { recursive: true, force: true });
      }
    }
    await fs.chmod(target, sourceStat.mode & 0o777);
    return;
  }

  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const staged = `${target}.restore-file-${process.pid}-${Date.now()}`;
  await fs.rm(staged, { recursive: true, force: true });
  if (sourceStat.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(source), staged);
  } else {
    await fs.copyFile(source, staged);
    await fs.chmod(staged, sourceStat.mode & 0o777);
  }
  const targetStat = await lstatOrNull(target);
  if (targetStat?.isDirectory()) {
    await fs.rm(target, { recursive: true, force: true });
  }
  await fs.rename(staged, target);
}

async function reconcileDirectoryFromSnapshot(params: {
  source: string;
  target: string;
  preserveRelativePaths: readonly string[];
  excludeFromPreservedCopies: readonly string[];
  preserveTargetPaths: readonly string[];
  prepareStagedState?: (stagedStateDir: string) => Promise<void>;
}): Promise<void> {
  const { source, target, preserveRelativePaths } = params;
  const parent = path.dirname(target);
  const staged = path.join(
    parent,
    `.${path.basename(target)}.restore-${process.pid}-${Date.now()}`,
  );
  await fs.cp(source, staged, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  await preserveCopiedModes(source, staged);
  for (const relativePath of preserveRelativePaths) {
    const livePath = path.join(target, relativePath);
    if (!(await exists(livePath))) {
      continue;
    }
    const stagedPath = path.join(staged, relativePath);
    await fs.rm(stagedPath, { recursive: true, force: true });
    await fs.mkdir(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
    await fs.cp(livePath, stagedPath, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: (sourcePath) =>
        !params.excludeFromPreservedCopies.some((excludedPath) =>
          isWithinPath(excludedPath, path.resolve(sourcePath)),
        ),
    });
    await preserveCopiedModes(livePath, stagedPath);
  }
  await params.prepareStagedState?.(staged);
  // Marker reads and delivery reconciliation in the updater share this cache.
  // Close it before replacing the directory so no later write targets a
  // displaced inode after rollback.
  closeOpenClawStateDatabase();
  try {
    // Keep the canonical state directory and its marker path present. Each
    // file replacement is atomic, so a killed updater leaves a discoverable
    // nonterminal marker for the detached handoff recovery executor.
    await copySnapshotEntryAtomically(staged, target, params.preserveTargetPaths);
    await fs.rm(staged, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(staged, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function replaceFileFromSnapshot(source: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const staged = `${target}.restore-${process.pid}-${Date.now()}`;
  await fs.copyFile(source, staged);
  await preserveCopiedModes(source, staged);
  await fs.rm(target, { recursive: true, force: true });
  await fs.rename(staged, target);
}

async function replaceSymlinkAtomically(target: string, linkTarget: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const staged = `${target}.restore-link-${process.pid}-${Date.now()}`;
  await fs.rm(staged, { recursive: true, force: true });
  await fs.symlink(linkTarget, staged);
  await fs.rm(target, { recursive: true, force: true });
  await fs.rename(staged, target);
}

/** Restore a snapshot while the service is stopped. */
export async function restoreUpdateStateSnapshot(
  snapshot: UpdateStateSnapshot,
  options?: { prepareStagedState?: (stagedStateDir: string) => Promise<void> },
): Promise<void> {
  const snapshotStateRoot = path.join(snapshot.root, "state");
  // Every strategy captures the full tree. Directory replacement restores
  // absence as well as content, so candidate-created state cannot survive.
  await reconcileDirectoryFromSnapshot({
    source: snapshotStateRoot,
    target: snapshot.stateDir,
    preserveRelativePaths: snapshot.excludedStatePaths,
    // The snapshot can live under an excluded managed-install prefix. Keep
    // its small journal/config metadata, but never recursively copy its state
    // image into the state image being restored.
    excludeFromPreservedCopies: [snapshotStateRoot],
    // Avoid copying the image into itself, but retain the authoritative live
    // image until confirmed cleanup removes the whole snapshot.
    preserveTargetPaths: [snapshotStateRoot],
    ...(options?.prepareStagedState ? { prepareStagedState: options.prepareStagedState } : {}),
  });
  if (snapshot.configSnapshot) {
    await replaceFileFromSnapshot(
      path.join(snapshot.root, snapshot.configSnapshot),
      snapshot.configPath,
    );
  } else if (snapshot.configDisposition === "external-absent") {
    await fs.rm(snapshot.configPath, { recursive: true, force: true });
  }
  if (snapshot.configSymlinkTarget !== null) {
    await replaceSymlinkAtomically(snapshot.requestedConfigPath, snapshot.configSymlinkTarget);
  }
}

export async function removeUpdateStateSnapshot(snapshot: UpdateStateSnapshot): Promise<void> {
  await fs.rm(snapshot.root, { recursive: true, force: true });
}
