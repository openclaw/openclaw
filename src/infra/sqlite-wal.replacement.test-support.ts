import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { configureSqliteWalMaintenance } from "./sqlite-wal.js";

const [role, databasePath, staleCloseMarker] = process.argv.slice(2);
assert.ok(role === "worker" || role === "stale" || role === "current");
assert.ok(databasePath && staleCloseMarker);
if (role === "worker") {
  const worker = new Worker(new URL(import.meta.url), {
    argv: ["stale", databasePath, staleCloseMarker],
  });
  await once(worker, "online");
} else if (role === "stale") {
  const stale = new DatabaseSync(databasePath);
  setTimeout(() => {
    fs.writeFileSync(staleCloseMarker, stale.isOpen ? "open" : "closed");
    process.kill(process.pid, "SIGKILL");
  }, 5_000);
  configureSqliteWalMaintenance(stale, {
    autoCheckpointPages: 0,
    checkpointIntervalMs: 2_500,
    databaseLabel: "replacement-family-test",
    databasePath,
  });
  stale.prepare("INSERT INTO events VALUES (?)").run("stale");
  process.stdout.write("stale-ready\n");
} else {
  const current = new DatabaseSync(databasePath);
  current.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  current.prepare("INSERT INTO events VALUES (?)").run("current");
  process.stdout.write("current-ready\n");
}
setInterval(() => {}, 1_000);
