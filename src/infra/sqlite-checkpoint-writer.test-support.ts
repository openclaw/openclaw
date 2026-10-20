import { spawn } from "node:child_process";
import { once } from "node:events";

/** A separate process keeps POSIX writer locks independent of snapshot file reads. */
export async function startSqliteCheckpointWriter(databasePath: string) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=5000;");
    db.exec("CREATE TABLE snapshot_pair(id INTEGER PRIMARY KEY, generation INTEGER); INSERT INTO snapshot_pair VALUES(1,0),(2,0); CREATE TABLE snapshot_payload(data BLOB); INSERT INTO snapshot_payload VALUES(zeroblob(33554432)); PRAGMA wal_checkpoint(TRUNCATE);");
    let stopped = false;
    const commit = () => db.exec("BEGIN IMMEDIATE; UPDATE snapshot_pair SET generation=generation+1; COMMIT; PRAGMA wal_checkpoint(PASSIVE);");
    process.on("message", message => {
      if (message === "stop") stopped = true;
      else if (message === "commit") { commit(); process.send("committed"); }
    });
    function step() {
      if (stopped) { db.close(); process.disconnect(); return; }
      commit();
      setImmediate(step);
    }
    commit();
    process.send("ready");
    setImmediate(step);
  `,
      databasePath,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = once(child, "close");
  const message = () =>
    Promise.race([
      once(child, "message"),
      closed.then(([code]) => {
        throw new Error(`Checkpoint writer exited (${code}): ${stderr}`);
      }),
    ]);
  await message();
  return {
    async commit() {
      const reply = message();
      child.send("commit");
      await reply;
    },
    async stop() {
      child.send("stop");
      const [code] = await closed;
      if (code !== 0) {
        throw new Error(`Checkpoint writer failed (${code}): ${stderr}`);
      }
    },
  };
}
