import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import { readUpdatePhysicalDatabaseObservation } from "./update-physical-database-generations.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const sourceFiles = ["source.sqlite", "source.sqlite-shm", "source.sqlite-wal"];

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

function familyBytes(sourcePath: string) {
  return ["", "-wal", "-shm"].map((suffix) => fs.readFileSync(`${sourcePath}${suffix}`));
}

describe.each(["fresh", "retained"] as const)("%s image integrity", (acquisition) => {
  function createSnapshot(options: Parameters<typeof createVerifiedSqliteSnapshot>[0]) {
    return retainSnapshotWork(
      Promise.resolve().then(() => {
        if (acquisition === "fresh") {
          return createVerifiedSqliteSnapshot(options);
        }
        const sourceAcquisition = options.sourceAcquisition!;
        const observation = readUpdatePhysicalDatabaseObservation(
          options.sourcePath,
          sourceAcquisition.stagingRoot,
        );
        if (!observation.generation.ok) {
          throw observation.generation.error;
        }
        expect(observation.preparedSource).toBeDefined();
        return createVerifiedSqliteSnapshot({
          ...options,
          sourceAcquisition: { ...sourceAcquisition, preparedSource: observation.preparedSource },
        });
      }),
    );
  }

  it.each([0, 1, 2])(
    "preserves WAL artifacts and row IDs with auto_vacuum=%i",
    async (autoVacuum) => {
      const { directory, sourcePath, targetPath, sqlite, source, options } = fixture(autoVacuum);
      using _ = source;
      expect(fs.statSync(`${sourcePath}-wal`).size).toBeGreaterThan(0);
      const before = familyBytes(sourcePath);
      expect(await createSnapshot(options)).toMatchObject({
        path: targetPath,
        userVersion: 7,
      });
      using snapshot = new sqlite.DatabaseSync(targetPath, { readOnly: true });
      expect(snapshot.prepare("SELECT rowid, value FROM records ORDER BY rowid").all()).toEqual([
        { rowid: 71, value: "alpha" },
        { rowid: 81, value: "beta" },
      ]);
      expect(snapshot.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      expect(familyBytes(sourcePath)).toEqual(before);
      expect(fs.readdirSync(directory).toSorted()).toEqual(["snapshot.sqlite", ...sourceFiles]);
    },
  );

  it.each([
    ["index", undefined],
    ["foreign-key", undefined],
    ["catalog", undefined],
    ["index", "transform"],
    ["index", "validate"],
  ] as const)(
    "refuses private WAL %s corruption before %s, preserving source artifacts",
    async (corruption, callback) => {
      const { directory, sourcePath, source, options } = fixture();
      using _ = source;
      if (corruption === "foreign-key") {
        source.exec("PRAGMA foreign_keys = OFF; INSERT INTO children VALUES (99);");
      } else {
        source.enableDefensive?.(false);
        const [name, sql] =
          corruption === "index"
            ? ["records_value", "CREATE INDEX records_value ON records(alternate)"]
            : ["records", "invalid sql"];
        source.exec(`PRAGMA writable_schema = ON;
        UPDATE sqlite_schema SET sql = '${sql}' WHERE name = '${name}';
        PRAGMA writable_schema = OFF;`);
        if (corruption === "index") {
          const version = Number(source.prepare("PRAGMA schema_version").get()?.schema_version);
          source.exec(`PRAGMA schema_version = ${version + 1};`);
        }
      }
      const before = familyBytes(sourcePath);
      const invoked = vi.fn();
      await expect(
        createSnapshot({
          ...options,
          ...(callback ? { [callback]: invoked } : {}),
        }),
      ).rejects.toThrow(
        callback
          ? /integrity_check failed/iu
          : /integrity_check failed|foreign_key_check failed|malformed database schema/iu,
      );
      if (callback) {
        expect(invoked).not.toHaveBeenCalled();
      }
      expect(familyBytes(sourcePath)).toEqual(before);
      expect(fs.readdirSync(directory).toSorted()).toEqual(sourceFiles);
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
    expect(control.prepare("PRAGMA integrity_check").all()).not.toEqual([
      { integrity_check: "ok" },
    ]);
    control.exec("PRAGMA journal_mode = DELETE;");
    expect(control.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);

    await expect(createSnapshot(options)).rejects.toThrow(/integrity_check failed/iu);
    expect(fs.readFileSync(sourcePath)).toEqual(bytes);
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.readdirSync(directory).filter((name) => name.startsWith(".sqlite-"))).toEqual([]);
  });
});
