import fsSync, { createWriteStream, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import { compose, Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveCommandProcessSignal } from "../process/exec-spawn.js";
import { createAbortError, isAbortError } from "./abort-signal.js";

const BACKUP_ARCHIVE_IDLE_TIMEOUT_MS = 5 * 60_000;

/** Seal the manifest from observed entries after the single payload traversal. */
export function appendBackupManifest(payload: AsyncIterable<Buffer>, createManifest: () => Buffer) {
  return compose(
    payload,
    async function* (source: AsyncIterable<Buffer>) {
      // node-tar ends each uncompressed Pack with two 512-byte zero blocks.
      // Replace only that terminator; the payload headers and bytes stay intact.
      let tail: Buffer = Buffer.alloc(0);
      for await (const chunk of source) {
        const length = Math.max(0, tail.length - Math.max(0, 1024 - chunk.length));
        if (length) {
          yield tail.subarray(0, length);
        }
        tail = length < tail.length ? Buffer.concat([tail.subarray(length), chunk]) : chunk;
      }
      if (tail.length > 1024) {
        yield tail.subarray(0, -1024);
      }
      yield createManifest();
    },
    createGzip(),
  );
}

type BackupArchiveProgress = {
  bytes?: number;
  entryPath?: string;
  phase: "entry" | "output" | "raw" | "traversal";
};

export type BackupArchiveCleanupReceipt = {
  archivePath: string;
  identity?: BigIntStats;
};

export type PreparedBackupArchive = BackupArchiveCleanupReceipt & {
  identity: BigIntStats;
};

// OpenClaw's one-user trust model treats hostile same-UID pathname rewrites as
// trusted host mutation. Keep the check and unlink synchronous so cooperative
// processes cannot interleave through an in-process await boundary.
export function removePreparedBackupArchive(prepared: PreparedBackupArchive): boolean {
  let currentIdentity: BigIntStats;
  try {
    currentIdentity = fsSync.lstatSync(prepared.archivePath, { bigint: true });
  } catch {
    return false;
  }
  if (!currentIdentity.isFile() || !sameFileIdentity(prepared.identity, currentIdentity)) {
    return false;
  }
  try {
    fsSync.unlinkSync(prepared.archivePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeArchiveStreamToFile(params: {
  archivePath: string;
  createArchiveStream: (
    reportProgress: (progress?: BackupArchiveProgress) => void,
    signal: AbortSignal,
  ) => NodeJS.ReadableStream;
  onPartialArchive: (receipt: BackupArchiveCleanupReceipt) => void;
}): Promise<PreparedBackupArchive> {
  // Own both stream lifecycles so a tar read error closes the output handle
  // before retry cleanup touches the partial archive. Exclusive creation also
  // refuses a pre-existing path instead of following a symlink.
  const controller = new AbortController();
  const signal = resolveCommandProcessSignal(controller.signal)!;
  signal.throwIfAborted();
  let opened = false;
  let openedIdentity: BigIntStats | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimeoutError: Error | undefined;
  let lastEntryPath: string | undefined;
  let lastProgress: BackupArchiveProgress | undefined;
  const bytes = { output: 0, raw: 0 };
  let settled = false;
  const describeProgress = () => {
    const entrySuffix = lastEntryPath
      ? `, entry=${JSON.stringify(sliceUtf16Safe(lastEntryPath, -512))}`
      : "";
    return `phase=${lastProgress?.phase ?? "starting"}${entrySuffix}, rawBytes=${bytes.raw}, outputBytes=${bytes.output}`;
  };
  const reportProgress = (progress?: BackupArchiveProgress) => {
    // One archive owns this watchdog. Late producer callbacks must not refresh
    // its timer after cleanup has completed.
    if (settled) {
      return;
    }
    if (progress) {
      lastProgress = progress;
      if (progress.entryPath) {
        lastEntryPath = progress.entryPath;
      }
      if (progress.bytes) {
        const phase =
          progress.phase === "output" ? "output" : progress.phase === "raw" ? "raw" : undefined;
        if (phase) {
          bytes[phase] += progress.bytes;
        }
      }
    }
    idleTimer =
      idleTimer?.refresh() ??
      setTimeout(() => {
        idleTimeoutError = new Error(
          `Backup archive write stalled: no progress observed for ${BACKUP_ARCHIVE_IDLE_TIMEOUT_MS}ms (${describeProgress()})`,
        );
        controller.abort(idleTimeoutError);
      }, BACKUP_ARCHIVE_IDLE_TIMEOUT_MS);
  };
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      reportProgress({ phase: "output", bytes: chunk.length });
      callback(null, chunk);
    },
  });

  const archiveWriteStream = createWriteStream(params.archivePath, {
    flags: "wx",
    flush: true,
    mode: 0o600,
  });
  archiveWriteStream.once("open", (fileDescriptor) => {
    opened = true;
    try {
      openedIdentity = fsSync.fstatSync(fileDescriptor, { bigint: true });
    } catch (error) {
      archiveWriteStream.destroy(error as Error);
    }
  });
  try {
    const archiveStream = params.createArchiveStream(reportProgress, signal);
    const pipelinePromise = pipeline(archiveStream, progress, archiveWriteStream, {
      signal,
    });
    reportProgress();
    await pipelinePromise;
    const currentIdentity = await fs.lstat(params.archivePath, { bigint: true });
    if (
      !openedIdentity?.isFile() ||
      !currentIdentity.isFile() ||
      !sameFileIdentity(openedIdentity, currentIdentity)
    ) {
      throw new Error(`Backup archive path changed while writing: ${params.archivePath}`);
    }
    signal.throwIfAborted();
    return { archivePath: params.archivePath, identity: currentIdentity };
  } catch (err) {
    let failure = idleTimeoutError ?? err;
    if (!idleTimeoutError && signal.aborted && err instanceof Error && isAbortError(err)) {
      // Capture the last observed activity before cleanup; never modify the
      // shared abort reason or let late producer callbacks rewrite the failure.
      const abortError = createAbortError(`${err.message} (${describeProgress()})`, { cause: err });
      if ("code" in err && (typeof err.code === "string" || typeof err.code === "number")) {
        Object.assign(abortError, { code: err.code });
      }
      failure = abortError;
    }
    archiveWriteStream.destroy();
    // A synchronous producer failure can precede open. Join descriptor closure
    // before checked unlink so a late open cannot recreate the partial archive.
    await finished(archiveWriteStream, { cleanup: true }).catch(() => undefined);
    if (!opened) {
      // A refused exclusive open never owned the pre-existing pathname.
      throw failure;
    }
    let cleanupReceipt: BackupArchiveCleanupReceipt | undefined = {
      archivePath: params.archivePath,
    };
    if (openedIdentity) {
      cleanupReceipt.identity = openedIdentity;
    } else {
      try {
        const currentIdentity = fsSync.lstatSync(params.archivePath, { bigint: true });
        if (currentIdentity.isFile()) {
          cleanupReceipt.identity = currentIdentity;
        }
      } catch (cleanupError) {
        // Preserve unknown identities for a later outer-cleanup attempt.
        if ((cleanupError as NodeJS.ErrnoException).code === "ENOENT") {
          cleanupReceipt = undefined;
        }
      }
    }
    if (
      cleanupReceipt &&
      (!cleanupReceipt.identity ||
        !removePreparedBackupArchive(cleanupReceipt as PreparedBackupArchive))
    ) {
      params.onPartialArchive(cleanupReceipt);
    }
    throw failure;
  } finally {
    settled = true;
    clearTimeout(idleTimer);
  }
}
