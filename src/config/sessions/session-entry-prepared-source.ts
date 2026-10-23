import fs from "node:fs";
import type { SessionEntrySnapshot } from "../../../packages/memory-host-sdk/src/host/session-files.js";
import type { SessionResetRecallCutoff } from "../../../packages/memory-host-sdk/src/host/session-reset-recall.js";

export type PreparedSessionEntryDescriptor = {
  snapshot: Omit<SessionEntrySnapshot, "events" | "deferred">;
  resetRecallCutoff: SessionResetRecallCutoff;
};

export type PreparedSessionEntrySource = PreparedSessionEntryDescriptor & {
  records: Iterable<unknown>;
};

/** Private length-prefixed UTF-8 records also preserve imported, pretty-printed JSON. */
export function* readPreparedSessionEntryRecords(filePath: string): Generator {
  // Synchronous file replay preserves the caller's explicit raw-ordinal yield cadence.
  // No SQLite handle or transaction survives preparation.
  const fd = fs.openSync(filePath, "r");
  try {
    const read = (buffer: Buffer, length: number, allowEnd = false) => {
      let offset = 0;
      while (offset < length) {
        const bytesRead = fs.readSync(fd, buffer, offset, length - offset, null);
        if (bytesRead === 0) {
          if (allowEnd && offset === 0) {
            return false;
          }
          throw new Error("Prepared session export ended inside a record");
        }
        offset += bytesRead;
      }
      return true;
    };
    const header = Buffer.alloc(4);
    let payload = Buffer.alloc(0);
    while (read(header, header.length, true)) {
      const length = header.readUInt32BE();
      if (payload.length < length) {
        payload = Buffer.allocUnsafe(length);
      }
      read(payload, length);
      // Decoded values do not borrow the workspace reused by the next record.
      yield JSON.parse(payload.toString("utf8", 0, length));
    }
  } finally {
    fs.closeSync(fd);
  }
}
