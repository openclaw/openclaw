import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { configureSqliteWalMaintenance } from "./sqlite-wal.js";

const [role, databasePath, staleCloseMarker] = process.argv.slice(2);
assert.ok(
  role === "worker" ||
    role === "stale" ||
    role === "current" ||
    role === "agent" ||
    role === "shared",
);
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
} else if (role === "agent" || role === "shared") {
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: path.join(path.dirname(databasePath), "state"),
  };
  const { openOpenClawStateDatabase } = await import("../state/openclaw-state-db.js");
  const agent = role === "agent" ? await import("../state/openclaw-agent-db.js") : undefined;
  if (agent) {
    openOpenClawStateDatabase({ env });
  }
  let periodic: (() => void) | undefined;
  const setIntervalNative = globalThis.setInterval;
  globalThis.setInterval = (callback, delay, ...args) => {
    if (delay === 30 * 60 * 1000 && typeof callback === "function") {
      assert.equal(periodic, undefined, "Expected exactly one published WAL timer");
      periodic = () => Reflect.apply(callback, undefined, args);
    }
    return setIntervalNative(callback, delay, ...args);
  };
  let stale: DatabaseSync;
  try {
    stale = agent
      ? agent.openOpenClawAgentDatabase({ agentId: "main", path: databasePath, env }).db
      : openOpenClawStateDatabase({ path: databasePath, env }).db;
  } finally {
    globalThis.setInterval = setIntervalNative;
  }
  assert.ok(periodic, "Published database did not register WAL maintenance");
  const tick = periodic;
  // sqlite-allow-raw -- The replacement must retain the canonical schema and checkpointed seed.
  stale.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE events (value TEXT PRIMARY KEY);");
  stale.prepare("INSERT INTO events VALUES (?)").run("base");
  stale.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  fs.copyFileSync(databasePath, `${databasePath}.seed`);
  stale.prepare("INSERT INTO events VALUES (?)").run("stale");
  const close = stale.close.bind(stale);
  stale.close = () => {
    fs.writeFileSync(staleCloseMarker, "closed");
    close();
  };
  process.on("message", (message) => {
    assert.equal(message, "tick");
    tick();
    process.send?.("survived-tick");
  });
  process.stdout.write("stale-ready\n");
} else {
  const current = new DatabaseSync(databasePath);
  current.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  current.prepare("INSERT INTO events VALUES (?)").run("current");
  process.stdout.write("current-ready\n");
}
if (role !== "agent" && role !== "shared") {
  setInterval(() => {}, 1_000);
}
