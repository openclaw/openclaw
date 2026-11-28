import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { encodeSqliteValue } from "../../snapshot/sqlite-cell-codec.js";
import { DatabasePortDataError } from "./port-descriptor.js";
import type { PortRow, PortTable } from "./port-types.js";

/** Recorded with table digests; proofs from older builds omit it and use the legacy JSON digest. */
export const PORT_ROW_DIGEST = "typed-v1";

/**
 * typed-v1 writes each value as a tag byte and 8 bytes (int64, float64 or byte length), then raw
 * TEXT/BLOB bytes. Integral numbers hash as integers because drivers differ (PostgreSQL int4 and
 * boolean arrive as numbers, SQLite and int8 as bigints), the legacy JSON number domain.
 */
export function createPortTableDigest(columns: PortTable["columns"], legacy: boolean) {
  const hash = createHash("sha256").update(JSON.stringify(columns) + "\n");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let used = 0;
  let rows = 0;
  const flush = () => {
    hash.update(chunk.subarray(0, used));
    used = 0;
  };
  const header = (tag: number) => {
    if (used + 9 > chunk.length) {
      flush();
    }
    chunk[used] = tag;
    used += 9;
    return used - 8;
  };
  const bytes = (value: string | Uint8Array, length: number) => {
    if (used + length > chunk.length) {
      flush();
      hash.update(value);
    } else if (typeof value === "string") {
      used += chunk.write(value, used, "utf8");
    } else {
      chunk.set(value, used);
      used += length;
    }
  };
  const update = (value: SQLInputValue) => {
    if (value === null) {
      chunk.writeBigUInt64BE(0n, header(0));
    } else if (typeof value === "bigint") {
      if (BigInt.asIntN(64, value) !== value) {
        throw new DatabasePortDataError("Port cannot hash an integer outside 64 bits");
      }
      chunk.writeBigInt64BE(value, header(1));
    } else if (typeof value === "number" && Number.isSafeInteger(value)) {
      chunk.writeBigInt64BE(BigInt(value), header(1));
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new DatabasePortDataError("Port cannot hash a non-finite REAL value");
      }
      chunk.writeDoubleBE(value, header(2));
    } else if (typeof value === "string") {
      const length = Buffer.byteLength(value);
      chunk.writeBigUInt64BE(BigInt(length), header(3));
      bytes(value, length);
    } else if (value instanceof Uint8Array) {
      chunk.writeBigUInt64BE(BigInt(value.byteLength), header(4));
      bytes(value, value.byteLength);
    } else {
      throw new DatabasePortDataError("Port cannot hash a non-byte array value");
    }
  };
  return {
    add(row: PortRow) {
      rows++;
      if (legacy) {
        hash.update(JSON.stringify(columns.map((c) => encodeSqliteValue(row[c.name]))) + "\n");
        return;
      }
      for (const column of columns) {
        update(row[column.name]!);
      }
    },
    result() {
      flush();
      return { rows, sha256: hash.digest("hex") };
    },
  };
}
