import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { copySourceFile } from "./sqlite-readonly-location.js";
import { SQLITE_LOCK_BYTE_RANGES } from "./sqlite-snapshot-file.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("copies a database past SQLite's locked bytes without reading them", () => {
  // Windows refuses reads of the lock bytes while another connection holds EXCLUSIVE.
  const lockBytes = 0x4000_0000;
  const root = tempDirs.make("openclaw-readonly-lock-bytes-");
  const sourcePath = path.join(root, "source.sqlite");
  fs.writeFileSync(sourcePath, "SQLite format 3\0", { mode: 0o600 });
  fs.truncateSync(sourcePath, lockBytes + 4096);
  const source = fs.openSync(sourcePath, "r+");
  fs.writeSync(source, Buffer.alloc(512, 0xff), 0, 512, lockBytes);
  fs.closeSync(source);
  const sourceIno = fs.statSync(sourcePath, { bigint: true }).ino;
  const readSync = fs.readSync;
  vi.spyOn(fs, "readSync").mockImplementation(((
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    if (
      fs.fstatSync(fd, { bigint: true }).ino === sourceIno &&
      position < lockBytes + 512 &&
      position + length > lockBytes
    ) {
      throw Object.assign(new Error("EBUSY: resource busy or locked, read"), { code: "EBUSY" });
    }
    return readSync(fd, buffer, offset, length, position);
  }) as typeof fs.readSync);
  // WAL and journal copies keep every byte; only the main database skips the lock bytes.
  expect(() => copySourceFile(sourcePath, path.join(root, "sidecar-copy"))).toThrow();
  const copy = path.join(root, "database-copy");
  copySourceFile(sourcePath, copy, undefined, SQLITE_LOCK_BYTE_RANGES);
  vi.restoreAllMocks();
  const target = fs.openSync(copy, "r");
  try {
    const lock = Buffer.alloc(512, 1);
    fs.readSync(target, lock, 0, 512, lockBytes);
    expect(lock.equals(Buffer.alloc(512))).toBe(true);
    expect(fs.fstatSync(target).size).toBe(lockBytes + 4096);
  } finally {
    fs.closeSync(target);
  }
});
