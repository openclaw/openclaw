import fs from "node:fs";
import { readFileWindowFullySync } from "@openclaw/fs-safe/advanced";
import {
  SQLITE_WAL_MAGIC_BE,
  SQLITE_WAL_MAGIC_LE,
  type SqliteChecksumByteOrder,
  sqliteWalChecksum,
} from "./sqlite-wal-checksum.js";

const WAL_HEADER_BYTES = 32;
const WAL_FRAME_HEADER_BYTES = 24;
const COPY_BUFFER_BYTES = 1024 * 1024;

type WalGeneration = {
  header: Buffer;
  byteOrder: SqliteChecksumByteOrder;
  frameBytes: number;
};

function readWalGeneration(descriptor: number): WalGeneration | undefined {
  const header = Buffer.alloc(WAL_HEADER_BYTES);
  if (readFileWindowFullySync(descriptor, header, 0) !== header.length) {
    return undefined;
  }
  const magic = header.readUInt32BE(0);
  if (magic !== SQLITE_WAL_MAGIC_LE && magic !== SQLITE_WAL_MAGIC_BE) {
    return undefined;
  }
  const byteOrder = magic === SQLITE_WAL_MAGIC_LE ? "LE" : "BE";
  const pageSize = header.readUInt32BE(8);
  const [first, second] = sqliteWalChecksum(header.subarray(0, 24), byteOrder);
  if (
    pageSize < 512 ||
    pageSize > 65_536 ||
    (pageSize & (pageSize - 1)) !== 0 ||
    header.readUInt32BE(24) !== first ||
    header.readUInt32BE(28) !== second
  ) {
    // SQLite ignores a WAL with an invalid header; keep the whole-file path.
    return undefined;
  }
  return { header, byteOrder, frameBytes: WAL_FRAME_HEADER_BYTES + pageSize };
}

/**
 * Copy the frames SQLite recovery would accept, up to the last commit frame
 * within the file length observed at capture. A restarted WAL rewrites frames
 * from offset 0 over a stale tail, so bytes past the last valid commit are
 * neither part of this generation's committed state nor stable under writers.
 */
function copyCommittedWalFrames(
  source: number,
  target: number,
  generation: WalGeneration,
  walBytes: number,
): number | false {
  const { header, byteOrder, frameBytes } = generation;
  if (readWalGeneration(source)?.header.equals(header) !== true) {
    return false;
  }
  const salt = header.subarray(16, 24);
  let checksum: readonly [number, number] = [header.readUInt32BE(24), header.readUInt32BE(28)];
  writeFully(target, header, 0);
  let committedEnd = WAL_HEADER_BYTES;
  const framesPerWindow = Math.max(1, Math.floor(COPY_BUFFER_BYTES / frameBytes));
  const buffer = Buffer.allocUnsafe(framesPerWindow * frameBytes);
  for (let position = WAL_HEADER_BYTES; position < walBytes;) {
    const window = buffer.subarray(0, Math.min(buffer.length, walBytes - position));
    const bytesRead = readFileWindowFullySync(source, window, position);
    let validBytes = 0;
    let complete = true;
    for (let offset = 0; offset + frameBytes <= bytesRead; offset += frameBytes) {
      const frame = window.subarray(offset, offset + frameBytes);
      if (frame.readUInt32BE(0) === 0 || !frame.subarray(8, 16).equals(salt)) {
        complete = false;
        break;
      }
      const next = sqliteWalChecksum(
        frame.subarray(WAL_FRAME_HEADER_BYTES),
        byteOrder,
        sqliteWalChecksum(frame.subarray(0, 8), byteOrder, checksum),
      );
      if (frame.readUInt32BE(16) !== next[0] || frame.readUInt32BE(20) !== next[1]) {
        complete = false;
        break;
      }
      checksum = next;
      validBytes = offset + frameBytes;
      if (frame.readUInt32BE(4) !== 0) {
        committedEnd = position + validBytes;
      }
    }
    if (validBytes > 0) {
      writeFully(target, window.subarray(0, validBytes), position);
    }
    if (!complete || validBytes < window.length) {
      break;
    }
    position += validBytes;
  }
  fs.ftruncateSync(target, committedEnd);
  fs.fsyncSync(target);
  return committedEnd;
}

function writeFully(target: number, bytes: Buffer, position: number): void {
  for (let offset = 0; offset < bytes.length;) {
    const written = fs.writeSync(target, bytes, offset, bytes.length - offset, position + offset);
    if (written <= 0) {
      throw new Error("SQLite WAL snapshot write made no progress");
    }
    offset += written;
  }
}

function matchesCapturedWalPrefix(source: number, destination: string, bytes: number): boolean {
  const copy = fs.openSync(destination, "r");
  try {
    const stat = fs.fstatSync(copy);
    if (!stat.isFile() || stat.size !== bytes) {
      return false;
    }
    const sourceBuffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, bytes));
    const copyBuffer = Buffer.allocUnsafe(sourceBuffer.length);
    for (let position = 0; position < bytes; position += sourceBuffer.length) {
      const length = Math.min(sourceBuffer.length, bytes - position);
      const sourceWindow = sourceBuffer.subarray(0, length);
      const copyWindow = copyBuffer.subarray(0, length);
      if (
        readFileWindowFullySync(source, sourceWindow, position) !== length ||
        readFileWindowFullySync(copy, copyWindow, position) !== length ||
        !sourceWindow.equals(copyWindow)
      ) {
        return false;
      }
    }
    return true;
  } finally {
    fs.closeSync(copy);
  }
}

/** Preserve source coordination bytes while SQLite interprets a bounded private WAL. */
export function prepareSqliteWalPrefixCopy(
  source: number,
  destination: string,
  verifyMainCopy: () => boolean,
): (() => boolean) | undefined {
  const generation = readWalGeneration(source);
  if (!generation) {
    // Empty or unrecognized WALs retain the conservative whole-file copy path.
    return undefined;
  }
  // A checkpoint may put existing frames into main. Capture its WAL prefix only
  // afterward, and fence resets across both copies, including main-file ABA.
  return () => {
    const walBytes = fs.fstatSync(source).size;
    if (!Number.isSafeInteger(walBytes) || walBytes < WAL_HEADER_BYTES) {
      return false;
    }
    const target = fs.openSync(destination, "wx", 0o600);
    let committedBytes: number | false;
    try {
      committedBytes = copyCommittedWalFrames(source, target, generation, walBytes);
    } finally {
      fs.closeSync(target);
    }
    // Committed frames are immutable within one WAL generation; appends and
    // rewrites of a stale tail past them are later commits, not a change.
    return (
      committedBytes !== false &&
      verifyMainCopy() &&
      matchesCapturedWalPrefix(source, destination, committedBytes) &&
      readWalGeneration(source)?.header.equals(generation.header) === true
    );
  };
}
