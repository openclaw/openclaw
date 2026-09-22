import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { startSqliteConcurrentWriter } from "./sqlite-concurrent-writer.test-support.js";
import { prepareSqliteReadOnlyLocationInProcess } from "./sqlite-readonly-location.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationSync,
} from "./sqlite-snapshot-source.js";

const writers: Array<ReturnType<typeof startSqliteConcurrentWriter>> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    try {
      await Promise.all(writers.splice(0).map((writer) => writer.stop()));
    } finally {
      cleanup();
    }
  });
});

function createTempDatabasePath(): string {
  return path.join(tempDirs.make("openclaw-sqlite-readonly-wal-"), "state.sqlite");
}

it.each([false, true])(
  "snapshots a static WAL family with rollback residue and no SHM (pending WAL=%s)",
  async (pendingWal) => {
    const sqlite = requireNodeSqlite();
    const source = createTempDatabasePath();
    const seedPath = `${source}.seed`;
    const seed = new sqlite.DatabaseSync(seedPath);
    const family = new Map<string, Buffer>();
    try {
      seed.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('checkpointed'); PRAGMA wal_checkpoint(TRUNCATE);",
      );
      if (pendingWal) {
        seed.exec("UPDATE probe SET value='committed-in-wal'");
      }
      for (const suffix of ["", "-wal"]) {
        family.set(suffix, fs.readFileSync(seedPath + suffix));
      }
    } finally {
      seed.close();
    }
    family.set("-journal", Buffer.alloc(0));
    for (const [suffix, bytes] of family) {
      fs.writeFileSync(source + suffix, bytes);
    }

    const prepared = prepareSqliteReadOnlyLocationSync(source);
    try {
      const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
      try {
        expect(snapshot.prepare("SELECT value FROM probe").get()).toEqual({
          value: pendingWal ? "committed-in-wal" : "checkpointed",
        });
        expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        snapshot.close();
      }
    } finally {
      expect(prepared.cleanup()).toBe(true);
    }
    for (const [suffix, bytes] of family) {
      expect(fs.readFileSync(source + suffix)).toEqual(bytes);
    }
    expect(fs.existsSync(`${source}-shm`)).toBe(false);
  },
);

it.each([
  { mode: "async", prepare: prepareSqliteReadOnlyLocationInProcess },
  { mode: "sync", prepare: prepareSqliteReadOnlyLocationSync },
  {
    mode: "artifact-preserving",
    prepare: (pathname: string) =>
      prepareSqliteReadOnlyLocation(pathname, { preserveSourceArtifacts: true }),
  },
])(
  "backs up an active WAL database during $mode inspection while another connection keeps writing",
  async ({ prepare }) => {
    const sqlite = requireNodeSqlite();
    const databasePath = createTempDatabasePath();
    const seed = new sqlite.DatabaseSync(databasePath);
    seed.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE writes (sequence INTEGER PRIMARY KEY);
    CREATE TABLE payload (data BLOB NOT NULL);
    INSERT INTO payload VALUES (zeroblob(16777216));
    PRAGMA wal_checkpoint(TRUNCATE);
  `);
    seed.close();
    const writer = startSqliteConcurrentWriter(databasePath, "WAL");
    writers.push(writer);
    try {
      const ready = await writer.waitFor("ready");
      expect(ready.commits).toBeGreaterThan(0);
      expect(writer.pid).not.toBe(process.pid);

      const prepared = await prepare(databasePath);
      const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
      try {
        expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
        expect(snapshot.prepare("SELECT COUNT(*) AS count FROM payload").get()).toEqual({
          count: 1,
        });
        expect(
          snapshot.prepare("SELECT COUNT(*) AS count FROM writes").get()?.count,
        ).toBeGreaterThan(0);
      } finally {
        snapshot.close();
        expect(prepared.cleanup()).toBe(true);
      }
      expect((await writer.progress()).commits).toBeGreaterThan(ready.commits);
    } finally {
      await writer.stop();
    }
  },
);
