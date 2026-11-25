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

function malformedFullAutoVacuumFixture() {
  const result = fixture(2);
  const { sourcePath, directory, sqlite, source } = result;
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
  return { ...result, bytes };
}

describe("canonical image integrity", () => {
  it("releases the live WAL pin before verifying the acquired image", async () => {
    const { sourcePath, targetPath, sqlite, source } = fixture();
    using _ = source;
    source.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    let checkpoint: Record<string, unknown> | undefined;
    const receipt = await createVerifiedSqliteSnapshot({
      sourcePath,
      targetPath,
      onStage: (stage, phase) => {
        if (stage === "source-integrity" && phase === "start") {
          using writer = new sqlite.DatabaseSync(sourcePath);
          writer.exec(
            "PRAGMA wal_autocheckpoint = 0; INSERT INTO records(rowid, value, alternate) VALUES (91, 'during', 'verification');",
          );
          checkpoint = writer.prepare("PRAGMA wal_checkpoint(PASSIVE);").get();
        }
      },
    });

    expect(checkpoint).toMatchObject({ busy: 0 });
    expect(Number(checkpoint?.log)).toBeGreaterThan(0);
    expect(checkpoint?.checkpointed).toBe(checkpoint?.log);
    expect(receipt).toMatchObject({ path: targetPath, userVersion: 7 });
    using snapshot = new sqlite.DatabaseSync(targetPath, { readOnly: true });
    expect(snapshot.prepare("SELECT value FROM records ORDER BY value").all()).toEqual([
      { value: "alpha" },
      { value: "beta" },
    ]);
    expect(source.prepare("SELECT value FROM records ORDER BY value").all()).toEqual([
      { value: "alpha" },
      { value: "beta" },
      { value: "during" },
    ]);
  });

  it("rejects physical nonunique-index corruption before compaction", async () => {
    const { sourcePath, targetPath, sqlite, source } = fixture();
    const rootPage = Number(
      source.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'records_value'").get()
        ?.rootpage,
    );
    source.close();
    const bytes = fs.readFileSync(sourcePath);
    const pageSize = bytes.readUInt16BE(16);
    const pageOffset = (rootPage - 1) * pageSize;
    const indexPage = bytes.subarray(pageOffset, pageOffset + pageSize);
    expect(indexPage[0]).toBe(0x0a);
    const keyOffset = indexPage.indexOf(Buffer.from("alpha"));
    expect(keyOffset).toBeGreaterThan(0);
    // Damage only the nonunique index's stored key, not its SQL definition or table.
    indexPage.write("omega", keyOffset, "utf8");
    fs.writeFileSync(sourcePath, bytes);

    const controlPath = path.join(path.dirname(sourcePath), "corruption-control.sqlite");
    fs.writeFileSync(controlPath, bytes);
    using control = new sqlite.DatabaseSync(controlPath);
    expect(control.prepare("PRAGMA integrity_check").all()).not.toEqual([
      { integrity_check: "ok" },
    ]);
    const stages: string[] = [];
    await expect(
      createVerifiedSqliteSnapshot({
        sourcePath,
        targetPath,
        onStage: (stage, phase) => stages.push(`${stage}:${phase}`),
      }),
    ).rejects.toThrow(/integrity_check failed/iu);
    expect(stages).not.toContain("vacuum:start");
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.readFileSync(sourcePath)).toEqual(bytes);
  });

  it.each(["canonical", "native"] as const)(
    "rejects FULL-auto-vacuum damage before %s acquisition can normalize it",
    async (acquisition) => {
      const { sourcePath, targetPath, directory, options, bytes } =
        malformedFullAutoVacuumFixture();
      // Keep a read-only native connection alive so WAL/SHM existence selects
      // online backup rather than the inactive-family raw-copy fallback.
      using liveSource = new (requireNodeSqlite().DatabaseSync)(sourcePath, { readOnly: true });
      liveSource.prepare("PRAGMA schema_version").get();
      await expect(
        createVerifiedSqliteSnapshot({
          sourcePath,
          targetPath,
          ...(acquisition === "native"
            ? {
                sourceAcquisition: { ...options.sourceAcquisition, preserveSourceArtifacts: false },
              }
            : {}),
        }),
      ).rejects.toThrow(/integrity_check failed/iu);
      expect(fs.readFileSync(sourcePath)).toEqual(bytes);
      expect(fs.existsSync(targetPath)).toBe(false);
      expect(fs.readdirSync(directory).filter((name) => name.startsWith(".sqlite-"))).toEqual([]);
    },
  );
});

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
    const { sourcePath, targetPath, directory, options, bytes } = malformedFullAutoVacuumFixture();

    await expect(createSnapshot(options)).rejects.toThrow(/integrity_check failed/iu);
    expect(fs.readFileSync(sourcePath)).toEqual(bytes);
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.readdirSync(directory).filter((name) => name.startsWith(".sqlite-"))).toEqual([]);
  });
});
