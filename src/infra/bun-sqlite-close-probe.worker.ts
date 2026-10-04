import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const retained: unknown[] = [];
// Keep native wrappers and live cursors reachable until the parent joins this worker.
parentPort?.on("message", () => retained.length);

function probe(): string {
  const directory: string = workerData;
  const other = new DatabaseSync(join(directory, "unrelated.sqlite"));
  retained.push(other);
  other.exec("CREATE TABLE unrelated(x); INSERT INTO unrelated VALUES (42)");
  for (const mode of ["close", "dispose"] as const) {
    const path = join(directory, `${mode}.sqlite`);
    const db = new DatabaseSync(path);
    retained.push(db);
    if (db.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode !== "wal") {
      return "SQLite close probe cannot establish WAL mode";
    }
    db.exec(
      "PRAGMA wal_autocheckpoint=0; CREATE TABLE data(x); INSERT INTO data VALUES (1),(2),(3)",
    );
    const stepped = db.prepare("SELECT x FROM data");
    stepped.get();
    const live = db.prepare("SELECT x FROM data");
    const cursor = live.iterate();
    cursor.next();
    retained.push(stepped, live, cursor, db.prepare("SELECT x FROM data"));
    const pages = db.prepare("PRAGMA page_count").get()?.page_count;
    const pageSize = db.prepare("PRAGMA page_size").get()?.page_size;
    const sidecars = ["-wal", "-shm"].map((suffix) => path + suffix);
    if (!sidecars.every(existsSync) || typeof pages !== "number" || typeof pageSize !== "number") {
      return "SQLite close probe WAL preconditions are unavailable";
    }
    if (mode === "close") {
      db.close();
    } else {
      db[Symbol.dispose]();
    }
    if (sidecars.some(existsSync) || statSync(path).size !== pages * pageSize) {
      return `SQLite ${mode} retained native WAL resources`;
    }
    let invalidated = false;
    try {
      stepped.get();
    } catch {
      invalidated = true;
    }
    if (!invalidated || other.prepare("SELECT x FROM unrelated").get()?.x !== 42) {
      return `SQLite ${mode} failed statement or sibling isolation`;
    }
  }
  return "";
}

try {
  parentPort?.postMessage(probe(), []);
} catch (error) {
  parentPort?.postMessage(`SQLite close probe failed: ${String(error)}`, []);
}
