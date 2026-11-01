import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { beforeAll, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { retireIdleOpenClawStateReadWorkers } from "../state/openclaw-state-read-worker.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { inspectDatabase } from "./backup-create-family.test-support.js";
import { createBackupArchive } from "./backup-create.js";
import { isolatedBackupCase } from "./backup-create.test-support.js";
import { ignoreMissingPath } from "./errno.js";
import { captureRetainedNativeWorkerSource } from "./worker-native-lifecycle.js";

beforeAll(async () => {
  // A warm broker outside the case root would hide the removed-socket regression.
  const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  expect(await retireIdleOpenClawStateReadWorkers(source)).toBe(true);
  expect(await source.retireIdleBroker()).toBe(true);
});

async function readFamily(filename: string) {
  return Promise.all(
    ["", "-wal", "-shm", "-journal"].map(async (suffix) => {
      const stat = await fs.stat(filename + suffix, { bigint: true }).catch(ignoreMissingPath);
      return stat
        ? {
            suffix,
            sha256: createHash("sha256")
              .update(await fs.readFile(filename + suffix))
              .digest("hex"),
            dev: stat.dev,
            ino: stat.ino,
            size: stat.size,
            mtime: stat.mtimeNs,
            ctime: stat.ctimeNs,
          }
        : { suffix, missing: true };
    }),
  );
}

it.each(["WAL", "DELETE"] as const)(
  "preserves the active %s source family and row IDs while sanitizing the archive",
  // Keep native socket paths below the fallback limit so they live in case scratch.
  isolatedBackupCase({ prefix: "bk-" })(async (state, mode) => {
    await state.writeConfig({ plugins: { enabled: false } });
    const sourcePath = state.statePath("state/openclaw.sqlite");
    const source = openOpenClawStateDatabase({ env: state.env });
    source.db.exec(`
      CREATE TABLE witness(value TEXT);
      INSERT INTO witness(rowid, value) VALUES (71, 'committed');
      INSERT INTO state_leases (scope, lease_key, owner, created_at, updated_at)
        VALUES ('synthetic-backup', 'witness', 'source', 1, 1);
    `);
    await closeOpenClawStateDatabaseAsync();
    // Keep the native source owner in another process: raw inspection must not
    // release a same-process writer's POSIX locks when its descriptors close.
    const script = `const {DatabaseSync}=require("node:sqlite");
      const db=new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode=${mode}; PRAGMA wal_autocheckpoint=0;");
      ${mode === "WAL" ? "db.exec(\"UPDATE witness SET value='committed in WAL'\");" : "db.exec(\"BEGIN IMMEDIATE; UPDATE witness SET value='uncommitted'\");"}
      process.stdin.resume();
      process.stdin.on("end",()=>{${mode === "DELETE" ? "db.exec('ROLLBACK');" : ""}db.close();});
      process.stdout.write(${JSON.stringify("ready\n")});`;
    const child = spawn(resolveTestNodeExecPath(), ["-e", script, sourcePath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    try {
      const ready = await Promise.race([
        once(child.stdout, "data"),
        exited.then(([code]) => {
          throw new Error(`Synthetic writer exited before readiness: ${code}`);
        }),
      ]);
      expect(String(ready[0])).toBe("ready\n");
      const before = await readFamily(sourcePath);
      expect(
        before.find((entry) => entry.suffix === (mode === "WAL" ? "-wal" : "-journal"))?.size,
      ).toBeGreaterThan(0n);
      const archive = await createBackupArchive({
        output: state.path("backup.tar.gz"),
        includeWorkspace: false,
        preserveSourceArtifacts: true,
      });
      expect(await readFamily(sourcePath)).toEqual(before);
      const extractDir = state.path("extracted");
      await fs.mkdir(extractDir);
      await tar.x({ file: archive.archivePath, cwd: extractDir });
      const stateAsset = archive.assets.find((asset) => asset.kind === "state")!;
      inspectDatabase(
        path.join(extractDir, stateAsset.archivePath, "state/openclaw.sqlite"),
        (db) => {
          expect(db.prepare("SELECT rowid, value FROM witness").all()).toEqual([
            { rowid: 71, value: mode === "WAL" ? "committed in WAL" : "committed" },
          ]);
          expect(db.prepare("SELECT * FROM state_leases").all()).toEqual([]);
        },
      );
    } finally {
      child.stdin.end();
      expect((await exited)[0]).toBe(0);
    }
  }),
);
