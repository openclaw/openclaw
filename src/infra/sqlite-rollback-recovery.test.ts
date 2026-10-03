import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createHotSqliteRollbackJournal } from "../../test/helpers/sqlite-hot-journal.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareSqliteRollbackRecovery } from "./sqlite-rollback-recovery.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(mode = 0o600) {
  const root = fs.realpathSync(dirs.make("sqlite-rollback-recovery-"));
  const file = path.join(root, "operation.sqlite");
  const database = new DatabaseSync(file);
  database.exec(
    "CREATE TABLE receipt (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO receipt VALUES (7, 'committed');",
  );
  database.close();
  fs.chmodSync(file, mode);
  const identity = fs.statSync(file, { bigint: true });
  const directory = fs.statSync(root, { bigint: true });
  const assertIdentity = () => {
    const current = fs.lstatSync(file, { bigint: true });
    const parent = fs.lstatSync(root, { bigint: true });
    if (
      !current.isFile() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      !parent.isDirectory() ||
      parent.dev !== directory.dev ||
      parent.ino !== directory.ino
    ) {
      throw new Error("fixture identity changed");
    }
  };
  const assertFileSafe = (_file: string, stat: fs.BigIntStats) => {
    if (stat.uid !== identity.uid || (stat.mode & BigInt(mode === 0o600 ? 0o077 : 0o022)) !== 0n) {
      throw new Error("fixture file permissions changed");
    }
  };
  const read = (connection: DatabaseSync) =>
    connection.prepare("SELECT id, value FROM receipt").get();
  const prepare = () =>
    prepareSqliteRollbackRecovery({
      path: file,
      scratchRoot: root,
      assertIdentity,
      assertFileSafe,
      read,
    });
  const files = () =>
    fs
      .readdirSync(root)
      .toSorted()
      .map((name) => {
        const absolute = path.join(root, name);
        const stat = fs.lstatSync(absolute, { bigint: true });
        return {
          name,
          dev: stat.dev,
          ino: stat.ino,
          mode: stat.mode,
          mtime: stat.mtimeNs,
          content: fs.readFileSync(absolute),
        };
      });
  const crash = () =>
    createHotSqliteRollbackJournal({
      path: file,
      mutationSql: "UPDATE receipt SET value = 'uncommitted'",
    });
  return { file, root, read, prepare, files, crash };
}

describe.skipIf(process.platform === "win32")("explicit SQLite rollback recovery", () => {
  it.each([0o600, 0o644])(
    "recovers a killed writer with caller-owned %s permissions only after current authority admits it",
    async (mode) => {
      const f = fixture(mode);
      f.crash();
      const before = f.files();
      const reader = new DatabaseSync(f.file, { readOnly: true });
      try {
        expect(() => f.read(reader)).toThrow(expect.objectContaining({ errcode: 776 }));
      } finally {
        reader.close();
      }
      const admission = await f.prepare();
      expect(admission.record).toEqual({ id: 7, value: "committed" });
      expect(f.files()).toEqual(before);
      let checks = 0;
      expect(() =>
        admission.admit(() => {
          if (++checks === 2) {
            throw new Error("executor revoked before pager access");
          }
        }),
      ).toThrow("executor revoked before pager access");
      expect(f.files()).toEqual(before);
      admission.admit(() => {});
      const recovered = new DatabaseSync(f.file, { readOnly: true });
      try {
        expect(f.read(recovered)).toEqual({ id: 7, value: "committed" });
        expect(
          recovered
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'openclaw_hot_journal_pressure'")
            .get(),
        ).toBeUndefined();
      } finally {
        recovered.close();
      }
      expect(fs.existsSync(`${f.file}-journal`)).toBe(false);
      expect(fs.statSync(f.file).mode & 0o777).toBe(mode);
      expect(fs.readdirSync(f.root)).toEqual(["operation.sqlite"]);
    },
  );

  it("preserves a replaced rollback sidecar instead of adopting its recovery bytes", async () => {
    const f = fixture();
    f.crash();
    const admission = await f.prepare();
    const journal = `${f.file}-journal`;
    const replacement = path.join(f.root, "replacement-journal");
    fs.copyFileSync(journal, replacement);
    fs.renameSync(replacement, journal);
    const replaced = f.files();
    expect(() => admission.admit(() => {})).toThrow(/journal changed/u);
    expect(f.files()).toEqual(replaced);
  });

  it("refuses WAL without checkpointing, deleting sidecars, or invoking rollback admission", async () => {
    const f = fixture();
    const writer = new DatabaseSync(f.file);
    try {
      writer.exec("PRAGMA journal_mode=WAL; UPDATE receipt SET value='committed WAL';");
      const before = f.files();
      await expect(f.prepare()).rejects.toThrow();
      expect(f.files()).toEqual(before);
    } finally {
      writer.close();
    }
  });
});
