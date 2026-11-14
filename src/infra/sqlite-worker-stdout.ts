import { writeSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { hasErrnoCode } from "./errno.js";
import type { SqliteReadOnlyWorkerResult } from "./sqlite-readonly-worker-protocol.js";

export async function writeSqliteWorkerResponse(result: SqliteReadOnlyWorkerResult): Promise<void> {
  // UNKNOWN stdout streams can discard bytes; direct fd writes also need to
  // preserve partial progress when startup imports make stdout nonblocking.
  const payload = Buffer.from(JSON.stringify(result));
  let offset = 0;
  while (offset < payload.length) {
    try {
      const written = writeSync(1, payload, offset, payload.length - offset);
      if (written > 0) {
        offset += written;
        continue;
      }
    } catch (error) {
      if (!hasErrnoCode(error, "EAGAIN") && !hasErrnoCode(error, "EWOULDBLOCK")) {
        throw error;
      }
    }
    // Yield without spinning. The launching parent's deadline and output limit
    // still bound this one-shot child, including a reader that stops draining.
    await setTimeout(10);
  }
}
