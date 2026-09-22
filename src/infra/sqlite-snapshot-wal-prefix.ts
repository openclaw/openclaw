import fs from "node:fs";
import { readFileWindowFullySync } from "@openclaw/fs-safe/advanced";

const WAL_HEADER_BYTES = 32;
const COPY_BUFFER_BYTES = 1024 * 1024;

function readWalGeneration(descriptor: number): Buffer | undefined {
  const header = Buffer.alloc(WAL_HEADER_BYTES);
  if (readFileWindowFullySync(descriptor, header, 0) !== header.length) {
    return undefined;
  }
  const magic = header.readUInt32BE(0);
  return magic === 0x377f_0682 || magic === 0x377f_0683 ? header : undefined;
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
export function copySqliteWalPrefixSync(
  source: number,
  destination: string,
  copyMain: () => void,
  verifyMainCopy: () => boolean,
): boolean | undefined {
  const generation = readWalGeneration(source);
  if (!generation) {
    // Empty or unrecognized WALs retain the conservative whole-file copy path.
    return undefined;
  }
  // A checkpoint may put existing frames into main. Capture its WAL prefix only
  // afterward, and fence resets across both copies, including main-file ABA.
  copyMain();
  const walBytes = fs.fstatSync(source).size;
  if (!Number.isSafeInteger(walBytes) || walBytes < generation.length) {
    return false;
  }
  const target = fs.openSync(destination, "wx", 0o600);
  try {
    const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, walBytes));
    for (let position = 0; position < walBytes;) {
      const window = buffer.subarray(0, Math.min(buffer.length, walBytes - position));
      if (readFileWindowFullySync(source, window, position) !== window.length) {
        return false;
      }
      if (position === 0 && !window.subarray(0, generation.length).equals(generation)) {
        return false;
      }
      for (let offset = 0; offset < window.length;) {
        const written = fs.writeSync(
          target,
          window,
          offset,
          window.length - offset,
          position + offset,
        );
        if (written <= 0) {
          throw new Error("SQLite WAL snapshot write made no progress");
        }
        offset += written;
      }
      position += window.length;
    }
    fs.fsyncSync(target);
  } finally {
    fs.closeSync(target);
  }
  // Whole-file equality would reject valid appends; verify only captured bytes.
  return (
    verifyMainCopy() &&
    matchesCapturedWalPrefix(source, destination, walBytes) &&
    readWalGeneration(source)?.equals(generation) === true
  );
}
