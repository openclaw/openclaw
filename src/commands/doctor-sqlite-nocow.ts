/** Offline btrfs rewrites retain the original directory and SQLite's WAL-aware backup. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot } from "@openclaw/fs-safe/root";
import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/host/sqlite-vec.js";
import { requireDirectorySync, syncDirectory } from "../infra/directory-durability.js";
import { copyFileHandle, sameFileMutationFingerprint } from "../infra/file-descriptor.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { createVerifiedSqliteSnapshot } from "../infra/sqlite-snapshot.js";
import { isSqlitePathOnBtrfs, setSqliteDirectoryNoCow } from "../infra/sqlite-wal-filesystem.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { assertDoctorSqliteMaintenancePathsNotAliased } from "./doctor-sqlite-maintenance-lock.js";

const TOOL_TIMEOUT_MS = 2_000;
const FUSER_MAX_PATHS = 2_000;
// Leave room for the inherited environment and argv pointers under Linux ARG_MAX.
const FUSER_MAX_PATH_BYTES = 64 * 1024;

function hasNoCow(pathname: string): boolean {
  const result = spawnSync("lsattr", ["-d", "--", pathname], {
    encoding: "utf8",
    timeout: TOOL_TIMEOUT_MS,
  });
  const flags = result.stdout?.trim().split(/\s+/u)[0];
  if (result.error || result.status !== 0 || !flags || !/^[a-zA-Z-]+$/u.test(flags)) {
    throw new Error(
      "NOCOW check skipped: lsattr is unavailable or could not read file attributes.",
    );
  }
  return flags.includes("C");
}

export function inspectDoctorSqliteNoCow(paths: readonly string[]) {
  const result: { paths: string[]; notes: string[] } = { paths: [], notes: [] };
  for (const pathname of new Set(paths)) {
    try {
      if (!fs.existsSync(pathname) || !isSqlitePathOnBtrfs(pathname)) {
        continue;
      }
      if (!hasNoCow(pathname) || !hasNoCow(path.dirname(pathname))) {
        result.paths.push(pathname);
        result.notes.push(
          `SQLite store on btrfs without NOCOW: ${pathname}. Run openclaw doctor --fix to rewrite it while the Gateway is stopped.`,
        );
      }
    } catch (error) {
      result.notes.push(`${pathname}: ${String(error)}`);
    }
  }
  return result;
}

async function copyRegularFile(sourcePath: string, targetPath: string, assertCurrent: () => void) {
  const source = await fsp.open(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const identity = await source.stat();
    assertCurrent();
    const target = await fsp.open(targetPath, "wx", 0o600);
    try {
      await copyFileHandle(source, target);
      if ((await target.stat()).size !== identity.size) {
        throw new Error(`SQLite NOCOW copy size mismatch: ${sourcePath}`);
      }
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

function runAclTool(command: "getfacl" | "setfacl", args: string[], input?: string): string {
  // POSIX mode suppresses default ACLs and disables the required setfacl options.
  const env = { ...process.env };
  delete env.POSIXLY_CORRECT;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: TOOL_TIMEOUT_MS,
    input,
    env,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`NOCOW repair requires working ${command} to preserve access and default ACLs`);
  }
  return result.stdout.trim();
}

function readAcl(pathname: string): string {
  return runAclTool("getfacl", ["-cEpn", "--", pathname]);
}

function sameDirectoryMetadata(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (["dev", "ino", "mode", "uid", "gid"] as const).every((key) => left[key] === right[key]);
}

function preserveMetadata(target: string, original: fs.BigIntStats, acl: string) {
  const current = fs.statSync(target);
  if (BigInt(current.uid) !== original.uid || BigInt(current.gid) !== original.gid) {
    fs.chownSync(target, Number(original.uid), Number(original.gid));
  }
  // Mask inherited named grants until the source ACL replaces them.
  const mode = Number(original.mode) & 0o7777;
  fs.chmodSync(target, mode & 0o7700);
  if (original.isDirectory()) {
    runAclTool("setfacl", ["-k", "--", target]);
  }
  runAclTool("setfacl", ["-n", "--set-file=-", "--", target], `${acl}\n`);
  if (readAcl(target) !== acl || (fs.statSync(target).mode & 0o7777) !== mode) {
    throw new Error(`NOCOW copy ACL verification failed: ${target}`);
  }
  if (original.isFile()) {
    const descriptor = fs.openSync(target, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
}

async function removeUninstalledDirectory(
  pathname: string,
  identity: fs.BigIntStats,
  assertCurrent: () => void,
) {
  const parent = await fsSafeRoot(path.dirname(pathname));
  await parent.remove(path.basename(pathname), {
    recursive: true,
    assertBeforeMutation() {
      assertCurrent();
      const current = fs.lstatSync(pathname, { bigint: true });
      if (current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error(`NOCOW staging identity changed: ${pathname}`);
      }
    },
  });
}

async function quickCheck(pathname: string) {
  const db = openNodeSqliteDatabase(pathname, { readOnly: true, allowExtension: true });
  try {
    await loadSqliteVecExtension({ db });
    assertSqliteIntegrity(db, pathname, "quick_check");
  } finally {
    db.close();
  }
}

function assertNoOpenFiles(paths: readonly string[]) {
  const batches: string[][] = [];
  let batch: string[] = [];
  let batchBytes = 0;
  for (const pathname of paths) {
    const absolute = path.resolve(pathname);
    const bytes = Buffer.byteLength(absolute, "utf8") + 1;
    if (
      batch.length > 0 &&
      (batch.length >= FUSER_MAX_PATHS || batchBytes + bytes > FUSER_MAX_PATH_BYTES)
    ) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(absolute);
    batchBytes += bytes;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }

  const pids = new Set<string>();
  let inspectionError: string | undefined;
  for (const args of batches) {
    const result = spawnSync("fuser", args, {
      encoding: "utf8",
      timeout: TOOL_TIMEOUT_MS,
    });
    const stdout = result.stdout?.trim() ?? "";
    const stderr = result.stderr?.trim() ?? "";
    if (result.status === 0 && /^\d+(?:\s+\d+)*$/u.test(stdout)) {
      for (const pid of stdout.split(/\s+/u)) {
        pids.add(pid);
      }
    } else if (result.error || result.status !== 1 || stdout || stderr) {
      inspectionError ??=
        stderr ||
        result.error?.message ||
        (result.signal ? `signal ${result.signal}` : stdout || `exit status ${result.status}`);
    }
  }
  if (pids.size > 0) {
    throw new Error(
      `store files are open (pids: ${[...pids].join(", ")}); stop processes using this store before retrying`,
    );
  }
  if (inspectionError) {
    throw new Error(
      `fuser could not establish that all handles are closed: ${inspectionError}; ensure fuser is installed and can inspect processes using this store`,
    );
  }
}

function readStoreEntries(directory: string): fs.Dirent[] {
  const entries: fs.Dirent[] = [];
  const pending = [directory];
  // Recursive readdir follows directory symlinks, including targets outside the store.
  for (const parent of pending) {
    if (!fs.lstatSync(parent).isDirectory()) {
      throw new Error(`store directory changed during traversal: ${parent}`);
    }
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      entries.push(entry);
      if (entry.isDirectory()) {
        pending.push(path.join(entry.parentPath, entry.name));
      }
    }
  }
  return entries;
}

/** Only the live Doctor maintenance owner may call this after draining its database handles. */
export async function repairDoctorSqliteNoCow(params: {
  paths: readonly string[];
  stateDir: string;
  assertCurrent: () => void;
}): Promise<MigrationMessages> {
  const help = spawnSync("mv", ["--help"], { encoding: "utf8", timeout: TOOL_TIMEOUT_MS });
  if (
    help.error ||
    help.status !== 0 ||
    !help.stdout.includes("--exchange") ||
    !help.stdout.includes("--no-copy")
  ) {
    return {
      changes: [],
      warnings: [
        "SQLite NOCOW repair skipped: GNU mv with --exchange and --no-copy is required. Stores remain unchanged.",
      ],
    };
  }
  const result: MigrationMessages = { changes: [], warnings: [] };
  for (const directory of new Set(params.paths.map((pathname) => path.dirname(pathname)))) {
    let backup: string | undefined;
    let backupIdentity: fs.BigIntStats | undefined;
    let snapshotRoot: string | undefined;
    let snapshotIdentity: fs.BigIntStats | undefined;
    let snapshotsCompleted = 0;
    let exchangeAttempted = false;
    try {
      params.assertCurrent();
      const relative = path.relative(path.resolve(params.stateDir), path.resolve(directory));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("store directory must be owned by the active state directory");
      }
      assertDoctorSqliteMaintenancePathsNotAliased(
        "SQLite NOCOW repair",
        [directory],
        [params.stateDir],
      );
      const entries = readStoreEntries(directory);
      const files = entries.map((entry) => path.join(entry.parentPath, entry.name));
      const inventory = new Map(
        files.map((pathname) => [pathname, fs.lstatSync(pathname, { bigint: true })]),
      );
      assertDoctorSqliteMaintenancePathsNotAliased(
        "SQLite NOCOW repair",
        files.filter((pathname) => !inventory.get(pathname)!.isSymbolicLink()),
        [params.stateDir],
      );
      const sourceLinks = new Map<string, Buffer>();
      for (const [pathname, stat] of inventory) {
        if (stat.isSymbolicLink()) {
          sourceLinks.set(pathname, fs.readlinkSync(pathname, { encoding: "buffer" }));
        } else if (!stat.isFile() && !stat.isDirectory()) {
          const type = stat.isFIFO()
            ? "FIFO"
            : stat.isSocket()
              ? "socket"
              : stat.isBlockDevice()
                ? "block device"
                : stat.isCharacterDevice()
                  ? "character device"
                  : "unknown";
          throw new Error(`unsupported store directory entry (${type}): ${pathname}`);
        }
      }
      const regularPaths = files.filter((pathname) => inventory.get(pathname)!.isFile());
      const sqlitePaths = new Set(regularPaths.filter((pathname) => pathname.endsWith(".sqlite")));
      for (const pathname of params.paths) {
        if (inventory.get(pathname)?.isFile()) {
          sqlitePaths.add(pathname);
        }
      }
      const sharedMemoryPaths = new Set([...sqlitePaths].map((pathname) => `${pathname}-shm`));
      const sourceIdentity = fs.statSync(directory, { bigint: true });
      const sourceFiles = new Map(
        [...inventory].filter(
          ([pathname, stat]) => !stat.isFile() || !sharedMemoryPaths.has(pathname),
        ),
      );
      const sourceAcls = new Map(
        [directory, ...sourceFiles.keys()]
          .filter((pathname) => !sourceLinks.has(pathname))
          .map((pathname) => [pathname, readAcl(pathname)]),
      );
      // fuser follows links, so inspect only regular files owned by this tree.
      assertNoOpenFiles(regularPaths);
      const size = [...inventory.values()].reduce((total, stat) => total + stat.size, 0n);
      const space = fs.statfsSync(directory, { bigint: true });
      if (space.bavail * space.bsize < size * 2n) {
        throw new Error(
          `at least ${size * 2n} bytes of free space are required (twice the store directory size)`,
        );
      }
      backup = fs.mkdtempSync(`${directory}.nocow-backup-`);
      backupIdentity = fs.statSync(backup, { bigint: true });
      setSqliteDirectoryNoCow(backup);
      // Standalone WAL-aware backups remain outside both directories being exchanged.
      snapshotRoot = fs.mkdtempSync(`${directory}.nocow-snapshots-`);
      snapshotIdentity = fs.statSync(snapshotRoot, { bigint: true });
      for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
        const target = path.join(
          backup,
          path.relative(directory, path.join(entry.parentPath, entry.name)),
        );
        fs.mkdirSync(target, {
          recursive: true,
          mode: 0o700,
        });
        setSqliteDirectoryNoCow(target);
      }
      for (const [pathname, linkText] of sourceLinks) {
        const target = path.join(backup, path.relative(directory, pathname));
        const original = inventory.get(pathname)!;
        params.assertCurrent();
        fs.symlinkSync(linkText, target);
        fs.lchownSync(target, Number(original.uid), Number(original.gid));
      }
      for (const pathname of regularPaths) {
        params.assertCurrent();
        if (
          ["-wal", "-shm", "-journal"].some(
            (suffix) =>
              pathname.endsWith(suffix) && sqlitePaths.has(pathname.slice(0, -suffix.length)),
          )
        ) {
          continue;
        }
        const relativePath = path.relative(directory, pathname);
        const target = path.join(backup, relativePath);
        if (sqlitePaths.has(pathname)) {
          // SQLite consumes its sidecars too; its snapshot inputs must remain unaliased.
          assertDoctorSqliteMaintenancePathsNotAliased(
            "SQLite NOCOW repair",
            [pathname, ...["-wal", "-shm", "-journal"].map((suffix) => `${pathname}${suffix}`)],
            [params.stateDir],
          );
          const snapshotPath = path.join(snapshotRoot, relativePath);
          fs.mkdirSync(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
          await createVerifiedSqliteSnapshot({
            sourcePath: pathname,
            targetPath: snapshotPath,
            preserveRowIds: true,
            beforePublish: params.assertCurrent,
          });
          snapshotsCompleted++;
          params.assertCurrent();
          await copyRegularFile(snapshotPath, target, params.assertCurrent);
          await quickCheck(target);
          if (!hasNoCow(target)) {
            throw new Error(`NOCOW was not inherited by ${target}`);
          }
        } else {
          await copyRegularFile(pathname, target, params.assertCurrent);
        }
        params.assertCurrent();
        preserveMetadata(target, inventory.get(pathname)!, sourceAcls.get(pathname)!);
      }
      const sourceDirectories = [
        directory,
        ...files.filter((pathname) => inventory.get(pathname)!.isDirectory()),
      ];
      for (const sourceDirectory of sourceDirectories.toReversed()) {
        const stagedDirectory = path.join(backup, path.relative(directory, sourceDirectory));
        params.assertCurrent();
        preserveMetadata(
          stagedDirectory,
          sourceDirectory === directory ? sourceIdentity : inventory.get(sourceDirectory)!,
          sourceAcls.get(sourceDirectory)!,
        );
        requireDirectorySync(
          await syncDirectory(stagedDirectory),
          "SQLite NOCOW staging directory",
        );
      }
      params.assertCurrent();
      const observedFiles = readStoreEntries(directory).map((entry) =>
        path.join(entry.parentPath, entry.name),
      );
      assertNoOpenFiles(observedFiles.filter((pathname) => fs.lstatSync(pathname).isFile()));
      // A file can appear while fuser checks the previously observed inventory.
      const currentIdentity = fs.statSync(directory, { bigint: true });
      const currentFiles = readStoreEntries(directory)
        .map((entry) => path.join(entry.parentPath, entry.name))
        .filter((pathname) => {
          if (sharedMemoryPaths.has(pathname) && fs.lstatSync(pathname).isFile()) {
            return false;
          }
          // Reading a cleanly closed WAL database can create an empty WAL beside the source.
          if (
            pathname.endsWith("-wal") &&
            sqlitePaths.has(pathname.slice(0, -4)) &&
            !sourceFiles.has(pathname)
          ) {
            const stat = fs.lstatSync(pathname);
            return !stat.isFile() || stat.size !== 0;
          }
          return true;
        });
      if (
        !sameDirectoryMetadata(currentIdentity, sourceIdentity) ||
        readAcl(directory) !== sourceAcls.get(directory) ||
        currentFiles.length !== sourceFiles.size ||
        currentFiles.some((pathname) => {
          const expected = sourceFiles.get(pathname);
          const current = fs.lstatSync(pathname, { bigint: true });
          return (
            !expected ||
            (expected.isDirectory()
              ? !current.isDirectory() ||
                !sameDirectoryMetadata(expected, current) ||
                readAcl(pathname) !== sourceAcls.get(pathname)
              : !sameFileMutationFingerprint(expected, current) ||
                (expected.isSymbolicLink() &&
                  (!current.isSymbolicLink() ||
                    !fs
                      .readlinkSync(pathname, { encoding: "buffer" })
                      .equals(sourceLinks.get(pathname)!))))
          );
        })
      ) {
        throw new Error(
          "source store changed during the NOCOW rewrite; original retained for retry",
        );
      }
      const original = fs.statSync(directory);
      const replacement = fs.statSync(backup);
      params.assertCurrent();
      exchangeAttempted = true;
      const exchange = spawnSync("mv", ["--exchange", "--no-copy", "-T", "--", backup, directory], {
        encoding: "utf8",
        timeout: TOOL_TIMEOUT_MS,
      });
      const installed = fs.statSync(directory);
      const retained = fs.statSync(backup);
      // A timed-out helper may already have committed. Physical identities settle that outcome.
      if (
        installed.dev === original.dev &&
        installed.ino === original.ino &&
        retained.dev === replacement.dev &&
        retained.ino === replacement.ino
      ) {
        exchangeAttempted = false;
      }
      if (
        installed.dev !== replacement.dev ||
        installed.ino !== replacement.ino ||
        retained.dev !== original.dev ||
        retained.ino !== original.ino
      ) {
        throw new Error(
          `atomic directory exchange failed: ${exchange.error?.message ?? exchange.stderr}`,
        );
      }
      requireDirectorySync(
        await syncDirectory(path.dirname(directory)),
        "SQLite NOCOW store parent",
      );
      result.changes.push(
        `Rewrote SQLite store directory with NOCOW: ${directory}. Original retained at ${backup}; verified WAL-aware snapshots at ${snapshotRoot}.`,
      );
    } catch (error) {
      if (exchangeAttempted) {
        throw new DoctorMaintenanceRefusalError(
          `SQLite NOCOW directory publication needs inspection: ${directory}; retained directory: ${backup}. ${String(error)}`,
          { kind: "data-at-risk", reason: "incomplete-migration" },
        );
      }
      for (const { pathname, identity } of [
        ...(backup && backupIdentity ? [{ pathname: backup, identity: backupIdentity }] : []),
        ...(snapshotRoot && snapshotIdentity && snapshotsCompleted === 0
          ? [{ pathname: snapshotRoot, identity: snapshotIdentity }]
          : []),
      ]) {
        try {
          await removeUninstalledDirectory(pathname, identity, params.assertCurrent);
          if (pathname === backup) {
            backup = undefined;
          }
          if (pathname === snapshotRoot) {
            snapshotRoot = undefined;
          }
        } catch (cleanupError) {
          result.warnings.push(
            `NOCOW staging cleanup failed; retained ${pathname}: ${String(cleanupError)}`,
          );
        }
      }
      result.warnings.push(
        `SQLite NOCOW repair refused for ${directory}: ${String(error)}${backup ? ` Recovery directory: ${backup}.` : ". Original store remains in place."}${snapshotRoot ? ` WAL-aware backup directory: ${snapshotRoot}.` : ""}`,
      );
    }
  }
  return result;
}
