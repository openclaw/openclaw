import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import * as tar from "tar";
import { normalizeArchivePath } from "../infra/backup-archive-path-policy.js";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "../infra/disk-space.js";
import { formatErrorMessage } from "../infra/errors.js";
import { BACKUP_MAX_DECOMPRESSION_RATIO } from "./backup-shared.js";
import {
  type NormalizedArchiveEntry,
  isRootBackupManifestEntry,
  isRegularArchiveFile,
  readBackupManifestEntry,
} from "./backup-verify-manifest.js";

const MAX_DATABASE_SNAPSHOT_EXTRACT_BYTES = 64 * 1024 * 1024 * 1024;
const DATABASE_SNAPSHOT_FREE_SPACE_RESERVE_BYTES = 256 * 1024 * 1024;

export function resolveExtractionBytes(
  entries: NormalizedArchiveEntry[],
  sqliteSnapshots = false,
): number {
  const label = sqliteSnapshots ? "SQLite snapshot" : "Archive";
  let totalBytes = 0;
  for (const entry of entries) {
    if (!sqliteSnapshots && !isRegularArchiveFile(entry.type)) {
      continue;
    }
    if (!Number.isSafeInteger(entry.size) || (entry.size ?? -1) < 0) {
      throw new Error(
        sqliteSnapshots
          ? `SQLite snapshot has an invalid archive size: ${entry.normalized}`
          : `Archive regular file has an invalid size: ${entry.normalized}`,
      );
    }
    if (sqliteSnapshots && entry.size === 0) {
      throw new Error(`SQLite snapshot is empty: ${entry.normalized}`);
    }
    totalBytes += entry.size ?? 0;
    if (!Number.isSafeInteger(totalBytes)) {
      throw new Error(`${label} extraction size exceeds the supported integer range.`);
    }
  }
  return totalBytes;
}

export async function assertSnapshotExtractionBudget(params: {
  entries: NormalizedArchiveEntry[];
  postgres?: boolean;
  tempRoot: string;
  spool: BackupArchiveSpool;
}): Promise<void> {
  const label = params.postgres ? "PostgreSQL artifacts" : "SQLite snapshots";
  const totalBytes = resolveExtractionBytes(params.entries, !params.postgres);
  if (totalBytes > MAX_DATABASE_SNAPSHOT_EXTRACT_BYTES) {
    throw new Error(
      `${label} require ${formatDiskSpaceBytes(totalBytes)} of extraction space; the verification limit is ${formatDiskSpaceBytes(MAX_DATABASE_SNAPSHOT_EXTRACT_BYTES)}.`,
    );
  }

  const remainingBytes = totalBytes - params.spool.retainedBytes(params.entries);
  let diskSpace = tryReadDiskSpace(params.tempRoot);
  if (
    diskSpace &&
    remainingBytes + DATABASE_SNAPSHOT_FREE_SPACE_RESERVE_BYTES > diskSpace.availableBytes
  ) {
    // Speculative files must not crowd out the artifacts this pass actually needs.
    await params.spool.discardExcept(params.entries);
    diskSpace = tryReadDiskSpace(params.tempRoot);
  }
  if (
    diskSpace &&
    remainingBytes + DATABASE_SNAPSHOT_FREE_SPACE_RESERVE_BYTES > diskSpace.availableBytes
  ) {
    throw new Error(
      `${label} require ${formatDiskSpaceBytes(remainingBytes)} of extraction space, but only ${formatDiskSpaceBytes(diskSpace.availableBytes)} is available near ${params.tempRoot}; verification reserves ${formatDiskSpaceBytes(DATABASE_SNAPSHOT_FREE_SPACE_RESERVE_BYTES)} for the host.`,
    );
  }
}

export async function assertSqliteSnapshotFileShape(
  extractedPath: string,
  archivePath: string,
  expectedSize: number,
): Promise<void> {
  const header = Buffer.alloc(100);
  const handle = await fs.open(extractedPath, "r");
  try {
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    if (
      bytesRead !== header.byteLength ||
      header.subarray(0, 16).toString("utf8") !== "SQLite format 3\u0000"
    ) {
      throw new Error(`SQLite snapshot ${archivePath} has an invalid database header.`);
    }
  } finally {
    await handle.close();
  }

  const encodedPageSize = header.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  const validPageSize = pageSize >= 512 && pageSize <= 65_536 && (pageSize & (pageSize - 1)) === 0;
  if (!validPageSize || expectedSize % pageSize !== 0) {
    throw new Error(`SQLite snapshot ${archivePath} has an invalid page layout.`);
  }

  const changeCounter = header.readUInt32BE(24);
  const declaredPageCount = header.readUInt32BE(28);
  const versionValidFor = header.readUInt32BE(92);
  const hasAuthoritativePageCount = declaredPageCount !== 0 && changeCounter === versionValidFor;
  if (hasAuthoritativePageCount && declaredPageCount !== expectedSize / pageSize) {
    throw new Error(`SQLite snapshot ${archivePath} has an invalid page layout.`);
  }
}

export async function prepareDatabaseArtifacts(
  archivePath: string,
  spool: BackupArchiveSpool,
  entries: NormalizedArchiveEntry[],
): Promise<string> {
  const { directory: tempDir, missing } = await spool.materialize(entries);
  const byRawPath = new Map(missing.map((entry) => [entry.raw, entry]));
  if (missing.length) {
    await tar.x({
      file: archivePath,
      gzip: true,
      maxDecompressionRatio: BACKUP_MAX_DECOMPRESSION_RATIO,
      cwd: tempDir,
      strict: true,
      preserveOwner: false,
      filter: (entryPath, archiveEntry) => {
        const expected = byRawPath.get(entryPath);
        if (!expected) {
          return false;
        }
        if (archiveEntry.size !== expected.size) {
          throw new Error(`Database artifact size changed during verification: ${entryPath}`);
        }
        return true;
      },
    });
  }
  spool.recordExtracted(missing, tempDir);
  for (const entry of entries) {
    const stat = await fs.lstat(path.join(tempDir, ...entry.normalized.split("/")));
    if (!stat.isFile() || stat.size !== entry.size) {
      throw new Error(`Extracted database artifact does not match archive: ${entry.normalized}`);
    }
  }
  return tempDir;
}

/** Retain possible databases until a trailing manifest and legacy registry establish ownership. */
export class BackupArchiveSpool {
  private directory: Promise<string> | undefined;
  private disabled = false;
  private nextFileId = 0;
  private readonly files = new Map<string, string>();
  private readonly materialized = new Map<string, string>();
  readonly tempRoot = os.tmpdir();

  private async root(): Promise<string> {
    const pending = (this.directory ??= fs.mkdtemp(
      path.join(this.tempRoot, "openclaw-backup-verify-"),
    ));
    try {
      return await pending;
    } catch (error) {
      this.directory = undefined;
      throw error;
    }
  }

  async capture(entry: tar.ReadEntry, normalized: string): Promise<void> {
    const declaredSize = entry.size;
    let candidate = /(?:\.sqlite|\.postgres\/(?:manifest\.json|\.pending))$/u.test(normalized);
    let decided = candidate;
    let prefix = Buffer.alloc(0);
    let filename: string | undefined;
    let output: Awaited<ReturnType<typeof fs.open>> | undefined;
    const abandon = async () => {
      this.disabled = true;
      this.files.delete(normalized);
      await output?.close().catch(() => undefined);
      output = undefined;
      if (filename) {
        await fs.rm(filename, { force: true }).catch(() => undefined);
      }
    };
    const write = async (bytes: Buffer) => {
      if (!candidate || this.disabled) {
        return;
      }
      try {
        if (!output) {
          const available = tryReadDiskSpace(this.tempRoot)?.availableBytes;
          // Opaque SQLite files are legal payload. If speculation cannot fit,
          // selected artifacts use the existing bounded extraction path.
          if (
            declaredSize > MAX_DATABASE_SNAPSHOT_EXTRACT_BYTES ||
            (available !== undefined &&
              declaredSize + DATABASE_SNAPSHOT_FREE_SPACE_RESERVE_BYTES > available)
          ) {
            candidate = false;
            return;
          }
          filename = path.join(await this.root(), `candidate-${this.nextFileId++}`);
          output = await fs.open(filename, "wx", 0o600);
          this.files.set(normalized, filename);
        }
        await output.writeFile(bytes);
      } catch {
        // Required artifacts still surface storage failures through extraction.
        await abandon();
      }
    };
    try {
      for await (const chunk of entry) {
        let bytes = chunk;
        if (!decided) {
          const needed = 16 - prefix.length;
          prefix = Buffer.concat([prefix, bytes.subarray(0, needed)]);
          if (prefix.length < 16) {
            continue;
          }
          candidate = prefix.toString("latin1") === "SQLite format 3\0";
          decided = true;
          if (candidate) {
            bytes = Buffer.concat([prefix, bytes.subarray(needed)]);
          }
        }
        await write(bytes);
        // Minipass may be destroyed during the write, between iterator reads.
        if (entry.destroyed) {
          break;
        }
      }
      if (declaredSize === 0) {
        await write(Buffer.alloc(0));
      }
    } finally {
      try {
        await output?.close();
      } catch {
        await abandon();
      }
    }
  }

  async materialize(
    entries: NormalizedArchiveEntry[],
  ): Promise<{ directory: string; missing: NormalizedArchiveEntry[] }> {
    const directory = path.join(await this.root(), "payload");
    const missing: NormalizedArchiveEntry[] = [];
    for (const entry of entries) {
      if (this.materialized.has(entry.normalized)) {
        continue;
      }
      const source = this.files.get(entry.normalized);
      if (!source) {
        missing.push(entry);
        continue;
      }
      const destination = path.join(directory, ...entry.normalized.split("/"));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      // Move instead of linking: PostgreSQL artifact admission requires nlink=1.
      await fs.rename(source, destination);
      this.files.delete(entry.normalized);
      this.materialized.set(entry.normalized, destination);
    }
    if (missing.length) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    }
    return { directory, missing };
  }

  retainedBytes(entries: NormalizedArchiveEntry[]): number {
    return entries.reduce(
      (total, entry) =>
        total +
        (this.files.has(entry.normalized) || this.materialized.has(entry.normalized)
          ? (entry.size ?? 0)
          : 0),
      0,
    );
  }

  async discardExcept(entries: NormalizedArchiveEntry[]): Promise<void> {
    const keep = new Set(entries.map((entry) => entry.normalized));
    for (const files of [this.files, this.materialized]) {
      for (const [name, file] of files) {
        if (!keep.has(name)) {
          await fs.rm(file);
          files.delete(name);
        }
      }
    }
  }

  recordExtracted(entries: NormalizedArchiveEntry[], directory: string): void {
    for (const entry of entries) {
      this.materialized.set(entry.normalized, path.join(directory, ...entry.normalized.split("/")));
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.directory) {
      await fs.rm(await this.directory, { recursive: true, force: true });
    }
  }
}

type ArchiveEntry = NormalizedArchiveEntry & {
  linkpath?: string;
};

export async function listBackupArchiveEntries(
  archivePath: string,
  consumeEntry?: (entry: tar.ReadEntry, normalized: string) => Promise<void>,
) {
  const entries: ArchiveEntry[] = [];
  let invalidReason: string | undefined;
  let pathError: Error | undefined;
  let manifestContent: Promise<string | Error> | undefined;
  const active = new Map<tar.ReadEntry, Promise<unknown>>();
  let consumeError: Error | undefined;
  try {
    await tar.t({
      noResume: true,
      file: archivePath,
      gzip: true,
      maxDecompressionRatio: BACKUP_MAX_DECOMPRESSION_RATIO,
      onwarn: (code, message) => {
        // tar skips invalid headers; a readable remainder is not a complete backup.
        if (code === "TAR_BAD_ARCHIVE" || code === "TAR_ENTRY_INVALID") {
          invalidReason ??= formatErrorMessage(message);
        }
      },
      onReadEntry: (entry) => {
        if (pathError) {
          entry.resume();
          return;
        }
        let normalized: string;
        try {
          normalized = normalizeArchivePath(entry.path, "Archive entry");
        } catch (error) {
          pathError ??= toStringifiedError(error);
          entry.resume();
          return;
        }
        entries.push({
          raw: entry.path,
          normalized,
          ...(entry.linkpath ? { linkpath: entry.linkpath } : {}),
          ...(Number.isSafeInteger(entry.size) && entry.size >= 0 ? { size: entry.size } : {}),
          ...(entry.type ? { type: entry.type } : {}),
        });
        // Own consumption so disk writes apply backpressure to the archive reader.
        // Duplicate manifests are still rejected after the complete inventory drains.
        let work: Promise<unknown> | undefined;
        if (!manifestContent && isRootBackupManifestEntry(normalized)) {
          manifestContent = readBackupManifestEntry(entry);
          work = manifestContent;
        } else if (consumeEntry && isRegularArchiveFile(entry.type)) {
          work = consumeEntry(entry, normalized).catch((error: unknown) => {
            consumeError ??= toStringifiedError(error);
          });
        }
        if (work) {
          active.set(entry, work);
          void work.finally(() => {
            active.delete(entry);
            entry.resume();
          });
        } else {
          entry.resume();
        }
      },
    });
  } catch (error) {
    for (const entry of active.keys()) {
      // Consumers between reads have no error listener; cancel all before joining them.
      entry.destroy();
    }
    throw error;
  } finally {
    await Promise.all(active.values());
  }
  if (consumeError) {
    throw consumeError;
  }
  return { entries, invalidReason, pathError, manifestContent };
}
