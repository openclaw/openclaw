import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture(autoVacuum = 0) {
  const directory = fs.realpathSync(directories.make("sqlite-snapshot-integrity-"));
  const sourcePath = path.join(directory, "source.sqlite");
  const targetPath = path.join(directory, "snapshot.sqlite");
  const sqlite = requireNodeSqlite();
  const source = new sqlite.DatabaseSync(sourcePath);
  source.exec(`
    PRAGMA auto_vacuum = ${autoVacuum};
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE records (value TEXT NOT NULL, alternate TEXT NOT NULL);
    CREATE INDEX records_value ON records(value);
    CREATE TABLE parents (id INTEGER PRIMARY KEY);
    CREATE TABLE children (parent_id INTEGER REFERENCES parents(id));
    INSERT INTO records(rowid, value, alternate) VALUES (71, 'alpha', 'zeta'), (81, 'beta', 'eta');
    PRAGMA user_version = 7;
  `);
  const options = {
    sourcePath,
    targetPath,
    preserveRowIds: true,
    sourceAcquisition: {
      mode: "isolated-process" as const,
      stagingRoot: directory,
      preserveSourceArtifacts: true,
    },
  };
  return { directory, sourcePath, targetPath, sqlite, source, options };
}

function observeIntegrity(sqlite: ReturnType<typeof requireNodeSqlite>) {
  const statements: string[] = [];
  // oxlint-disable-next-line typescript/unbound-method -- call preserves the native database receiver.
  const prepare = sqlite.DatabaseSync.prototype.prepare;
  const spy = vi.spyOn(sqlite.DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql,
  ) {
    if (/^PRAGMA (integrity_check|foreign_key_check);$/u.test(sql)) {
      statements.push(sql);
    }
    return prepare.call(this, sql);
  });
  return {
    finish: () => {
      spy.mockRestore();
      return statements;
    },
  };
}

function familyBytes(sourcePath: string) {
  return ["", "-wal", "-shm"].map((suffix) => fs.readFileSync(`${sourcePath}${suffix}`));
}

it.each([
  { acquisition: "artifacts", autoVacuum: 0, checks: 1 },
  { acquisition: "native", autoVacuum: 0, checks: 1 },
  { acquisition: "worker", autoVacuum: 0, checks: 1 },
  { acquisition: "artifacts", autoVacuum: 2, checks: 1 },
  { acquisition: "artifacts", autoVacuum: 1, checks: 2 },
] as const)(
  "uses $checks full checks for $acquisition WAL capture with auto_vacuum=$autoVacuum",
  async ({ acquisition, autoVacuum, checks }) => {
    const { directory, sourcePath, targetPath, sqlite, source, options } = fixture(autoVacuum);
    using _ = source;
    expect(fs.statSync(`${sourcePath}-wal`).size).toBeGreaterThan(0);
    const before = familyBytes(sourcePath);
    const observed = observeIntegrity(sqlite);

    const result = await createVerifiedSqliteSnapshot({
      ...options,
      sourceAcquisition:
        acquisition === "worker"
          ? undefined
          : { ...options.sourceAcquisition, preserveSourceArtifacts: acquisition === "artifacts" },
    });

    expect(observed.finish()).toEqual(
      Array.from({ length: checks }, () => [
        "PRAGMA integrity_check;",
        "PRAGMA foreign_key_check;",
      ]).flat(),
    );
    expect(result).toMatchObject({ path: targetPath, userVersion: 7 });
    using snapshot = new sqlite.DatabaseSync(targetPath, { readOnly: true });
    expect(snapshot.prepare("SELECT rowid, value FROM records ORDER BY rowid").all()).toEqual([
      { rowid: 71, value: "alpha" },
      { rowid: 81, value: "beta" },
    ]);
    expect(snapshot.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    if (acquisition !== "native") {
      expect(familyBytes(sourcePath)).toEqual(before);
    }
    expect(fs.readdirSync(directory).toSorted()).toEqual([
      "snapshot.sqlite",
      "source.sqlite",
      "source.sqlite-shm",
      "source.sqlite-wal",
    ]);
  },
);

it.each(["vacuum", "transform", "validator"] as const)(
  "keeps both checks before and after %s work",
  async (operation) => {
    const { sqlite, source, sourcePath, targetPath, options } = fixture();
    using _ = source;
    const labels: string[] = [];
    const observed = observeIntegrity(sqlite);
    await createVerifiedSqliteSnapshot({
      ...options,
      ...(operation === "vacuum" ? { preserveRowIds: false, sourceAcquisition: undefined } : {}),
      ...(operation === "transform"
        ? { transform: (db: DatabaseSync) => db.exec("UPDATE records SET value = 'new';") }
        : {}),
      ...(operation === "validator"
        ? {
            validate: (_db: DatabaseSync, label: string) => {
              labels.push(label);
            },
          }
        : {}),
    });
    expect(observed.finish()).toEqual([
      "PRAGMA integrity_check;",
      "PRAGMA foreign_key_check;",
      "PRAGMA integrity_check;",
      "PRAGMA foreign_key_check;",
    ]);
    if (operation === "validator") {
      expect(labels).toEqual([sourcePath, targetPath]);
    }
  },
);

function corruptIndex(source: DatabaseSync) {
  source.enableDefensive?.(false);
  source.exec(`
    PRAGMA writable_schema = ON;
    UPDATE sqlite_schema SET sql = 'CREATE INDEX records_value ON records(alternate)' WHERE name = 'records_value';
    PRAGMA writable_schema = OFF;
  `);
  const version = Number(source.prepare("PRAGMA schema_version").get()?.schema_version);
  source.exec(`PRAGMA schema_version = ${version + 1};`);
}

it.each(["index", "foreign-key", "catalog"] as const)(
  "refuses private WAL %s corruption without publishing or changing source artifacts",
  async (corruption) => {
    const { directory, sourcePath, targetPath, source, options } = fixture();
    using _ = source;
    if (corruption === "index") {
      corruptIndex(source);
    } else if (corruption === "foreign-key") {
      source.exec("PRAGMA foreign_keys = OFF; INSERT INTO children VALUES (99);");
    } else {
      source.enableDefensive?.(false);
      source.exec(
        "PRAGMA writable_schema = ON; UPDATE sqlite_schema SET sql = 'invalid sql' WHERE name = 'records'; PRAGMA writable_schema = OFF;",
      );
    }
    const before = familyBytes(sourcePath);
    await expect(createVerifiedSqliteSnapshot(options)).rejects.toThrow(
      /integrity_check failed|foreign_key_check failed|malformed database schema/iu,
    );
    expect(familyBytes(sourcePath)).toEqual(before);
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.readdirSync(directory).toSorted()).toEqual([
      "source.sqlite",
      "source.sqlite-shm",
      "source.sqlite-wal",
    ]);
  },
);

it.each(["transform", "validate"] as const)(
  "rejects corrupt input before invoking the %s callback",
  async (callback) => {
    const { source, targetPath, options } = fixture();
    using _ = source;
    corruptIndex(source);
    const invoked = vi.fn();
    await expect(createVerifiedSqliteSnapshot({ ...options, [callback]: invoked })).rejects.toThrow(
      /integrity_check failed/iu,
    );
    expect(invoked).not.toHaveBeenCalled();
    expect(fs.existsSync(targetPath)).toBe(false);
  },
);

it("rejects a malformed FULL-auto-vacuum freelist before normalization can erase it", async () => {
  const { sourcePath, targetPath, directory, sqlite, source, options } = fixture(2);
  source.exec(
    "CREATE TABLE payloads(value BLOB); INSERT INTO payloads VALUES(zeroblob(65536)); DELETE FROM payloads;",
  );
  source.close();
  const bytes = fs.readFileSync(sourcePath);
  const pageSize = bytes.readUInt16BE(16);
  const trunk = bytes.readUInt32BE(32);
  expect(trunk).toBeGreaterThan(0);
  expect(bytes.readUInt32BE(36)).toBeGreaterThan(0);
  // Keep the pointer map and free-page count valid, but corrupt the trunk chain.
  // FULL commit can discard the entire trailing freelist without traversing it.
  bytes.writeUInt32BE(0, 64);
  bytes.writeUInt32BE(bytes.length / pageSize + 1, (trunk - 1) * pageSize);
  fs.writeFileSync(sourcePath, bytes);
  const controlPath = path.join(directory, "normalization-control.sqlite");
  fs.writeFileSync(controlPath, bytes);
  using control = new sqlite.DatabaseSync(controlPath);
  expect(control.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 1 });
  expect(control.prepare("PRAGMA integrity_check").all()).not.toEqual([{ integrity_check: "ok" }]);
  control.exec("PRAGMA journal_mode = DELETE;");
  expect(control.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);

  await expect(createVerifiedSqliteSnapshot(options)).rejects.toThrow(/integrity_check failed/iu);
  expect(fs.readFileSync(sourcePath)).toEqual(bytes);
  expect(fs.existsSync(targetPath)).toBe(false);
  expect(fs.readdirSync(directory).filter((name) => name.startsWith(".sqlite-"))).toEqual([]);
});
