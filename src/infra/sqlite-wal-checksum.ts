// SQLite's WAL checksum (walChecksumBytes in sqlite3's wal.c).
export const SQLITE_WAL_MAGIC_LE = 0x377f_0682;
export const SQLITE_WAL_MAGIC_BE = 0x377f_0683;

export type SqliteChecksumByteOrder = "BE" | "LE";

export function readUint32(
  buffer: Buffer,
  offset: number,
  byteOrder: SqliteChecksumByteOrder,
): number {
  return byteOrder === "LE" ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

/** Frames chain their checksum from the previous frame (or the WAL header). */
export function sqliteWalChecksum(
  buffer: Buffer,
  byteOrder: SqliteChecksumByteOrder,
  seed: readonly [number, number] = [0, 0],
): readonly [number, number] {
  let [first, second] = seed;
  for (let offset = 0; offset < buffer.length; offset += 8) {
    first = (first + readUint32(buffer, offset, byteOrder) + second) >>> 0;
    second = (second + readUint32(buffer, offset + 4, byteOrder) + first) >>> 0;
  }
  return [first, second];
}
