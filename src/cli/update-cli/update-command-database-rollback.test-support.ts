import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Leaves `database` as a writer that exited just before capture would: a WAL family
 * with both sidecars and no holder. Copying it while open keeps the visible rows.
 */
export async function leaveExitedWriterWalFamily(database: string, scratch: string) {
  await fs.mkdir(scratch);
  {
    using writer = new DatabaseSync(database);
    writer.exec(
      "PRAGMA journal_mode=WAL; INSERT INTO payload(rowid,value) VALUES(1000,'transient'); DELETE FROM payload WHERE rowid=1000;",
    );
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.copyFile(`${database}${suffix}`, path.join(scratch, suffix || "db"));
    }
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    await fs.copyFile(path.join(scratch, suffix || "db"), `${database}${suffix}`);
  }
}
