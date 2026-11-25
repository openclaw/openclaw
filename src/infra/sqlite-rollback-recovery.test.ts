import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createHotSqliteRollbackJournal } from "../../test/helpers/sqlite-hot-journal.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareSqliteRollbackRecovery } from "./sqlite-rollback-recovery.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(permissions = 0o600) {
  const root = fs.realpathSync(dirs.make("sqlite-rollback-recovery-"));
  const file = path.join(root, "operation.sqlite");
  {
    using database = new DatabaseSync(file);
    database.exec("CREATE TABLE receipt(id,value); INSERT INTO receipt VALUES(7,'committed')");
  }
  fs.chmodSync(file, permissions);
  const identity = fs.statSync(file, { bigint: true });
  const directory = fs.statSync(root, { bigint: true });
  const assertIdentity = () => {
    const current = fs.lstatSync(file, { bigint: true });
    const parent = fs.lstatSync(root, { bigint: true });
    expect([current.isFile(), parent.isDirectory()]).toEqual([true, true]);
    expect([current, parent]).toMatchObject([
      { dev: identity.dev, ino: identity.ino },
      { dev: directory.dev, ino: directory.ino },
    ]);
  };
  const forbidden = BigInt(permissions === 0o600 ? 0o077 : 0o022);
  const assertFileSafe = (_file: string, stat: fs.BigIntStats) => {
    expect([stat.uid, stat.mode & forbidden]).toEqual([identity.uid, 0n]);
  };
  const read = (db: DatabaseSync) => db.prepare("SELECT id, value FROM receipt").get();
  const inspect = () => {
    using reader = new DatabaseSync(file, { readOnly: true });
    return {
      record: read(reader),
      pressure: reader
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'openclaw_hot_journal_pressure'")
        .get(),
    };
  };
  const options = { path: file, scratchRoot: root, assertIdentity, assertFileSafe, read };
  const prepare = () => prepareSqliteRollbackRecovery(options);
  const files = () =>
    fs
      .readdirSync(root)
      .toSorted()
      .map((name) => {
        const absolute = path.join(root, name);
        const { dev, ino, mode, mtimeNs: mtime } = fs.lstatSync(absolute, { bigint: true });
        return { name, dev, ino, mode, mtime, content: fs.readFileSync(absolute) };
      });
  const crash = () =>
    createHotSqliteRollbackJournal({
      path: file,
      mutationSql: "UPDATE receipt SET value = 'uncommitted'",
    });
  return { file, root, inspect, prepare, files, crash };
}

describe.skipIf(process.platform === "win32")("explicit SQLite rollback recovery", () => {
  it.each([0o600, 0o644])(
    "recovers a killed writer with caller-owned %s permissions only after current authority admits it",
    async (mode) => {
      const f = fixture(mode);
      f.crash();
      const before = f.files();
      expect(f.inspect).toThrow(expect.objectContaining({ errcode: 776 }));
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
      const timestamp = fs.statSync(f.file);
      fs.utimesSync(f.file, timestamp.atime, new Date(timestamp.mtimeMs + 1_000));
      admission.admit(() => {});
      expect(f.inspect()).toEqual({ record: { id: 7, value: "committed" }, pressure: undefined });
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
    using writer = new DatabaseSync(f.file);
    writer.exec("PRAGMA journal_mode=WAL; UPDATE receipt SET value='committed WAL';");
    const before = f.files();
    await expect(f.prepare()).rejects.toThrow();
    expect(f.files()).toEqual(before);
  });
});
