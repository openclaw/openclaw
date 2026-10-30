import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import * as tar from "tar";
import { normalizeArchivePath } from "../infra/backup-archive-path-policy.js";
import { tryReadDiskSpace } from "../infra/disk-space.js";
import { formatErrorMessage } from "../infra/errors.js";
import { BACKUP_MAX_DECOMPRESSION_RATIO } from "./backup-shared.js";
import {
  type NormalizedArchiveEntry,
  isRootBackupManifestEntry,
  isRegularArchiveFile,
  readBackupManifestEntry,
} from "./backup-verify-manifest.js";

export const MAX_DATABASE_SNAPSHOT_EXTRACT_BYTES = 64 * 1024 * 1024 * 1024;
export const DATABASE_SNAPSHOT_FREE_SPACE_RESERVE_BYTES = 256 * 1024 * 1024;

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
      entry.destroy(toStringifiedError(error));
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
