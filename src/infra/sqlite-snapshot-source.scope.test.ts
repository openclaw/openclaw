import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import * as nodeSqlite from "./node-sqlite.js";
import { cleanupSnapshotOperations } from "./sqlite-readonly-location-cleanup.js";
import { openSqliteReadOnlyDatabase } from "./sqlite-snapshot-source.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it("keeps one private WAL image across independent readers until the inspection ends", () => {
  const root = directories.make("sqlite-inspection-scope-");
  const source = path.join(root, "source.sqlite");
  using writer = nodeSqlite.openNodeSqliteDatabase(source);
  writer.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('first');",
  );
  const otherSource = path.join(root, "other.sqlite");
  {
    using other = nodeSqlite.openNodeSqliteDatabase(otherSource);
    other.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('other')");
  }
  const artifacts = () =>
    ["", "-wal", "-shm"].map((suffix) => fs.readFileSync(`${source}${suffix}`));
  const read = (database: ReturnType<typeof openSqliteReadOnlyDatabase>) =>
    database.prepare("SELECT value FROM probe").get();
  let location = "";
  const readers: Array<ReturnType<typeof openSqliteReadOnlyDatabase>> = [];
  const remove = fs.rmSync;
  const cleanup = vi.spyOn(fs, "rmSync").mockImplementation((pathname, options) => {
    if (location && pathname === path.dirname(location)) {
      expect(readers.every((reader) => !reader.isOpen)).toBe(true);
    }
    return remove(pathname, options);
  });
  try {
    withArtifactPreservingStateReads(
      () => {
        const before = artifacts();
        const first = openSqliteReadOnlyDatabase(source);
        readers.push(first);
        location = first.location()!;
        expect(location).not.toBe(source);
        expect(read(first)).toEqual({ value: "first" });
        first.close();
        expect(fs.existsSync(location)).toBe(true);
        expect(artifacts()).toEqual(before);
        writer.exec("UPDATE probe SET value='second'");
        const committed = artifacts();
        const other = openSqliteReadOnlyDatabase(otherSource);
        readers.push(other);
        expect(other.location()).not.toBe(location);
        expect(read(other)).toEqual({ value: "other" });
        const second = openSqliteReadOnlyDatabase(source, { readOnly: false });
        readers.push(second);
        expect(second === first).toBe(false);
        expect(second.location()).toBe(location);
        expect(read(second)).toEqual({ value: "first" });
        expect(() => second.exec("UPDATE probe SET value='unexpected'")).toThrow(/readonly/);
        expect(artifacts()).toEqual(committed);
      },
      { agentDatabases: true },
    );
    expect(readers.every((reader) => !reader.isOpen)).toBe(true);
    expect(fs.existsSync(location)).toBe(false);
    const committed = artifacts();
    withArtifactPreservingStateReads(
      () => {
        const next = openSqliteReadOnlyDatabase(source);
        expect(next.location()).not.toBe(location);
        expect(read(next)).toEqual({ value: "second" });
      },
      { agentDatabases: true },
    );
    expect(artifacts()).toEqual(committed);
  } finally {
    cleanup.mockRestore();
  }
});

it("retains the image when native close fails and preserves the inspection failure", async () => {
  const source = path.join(directories.make("sqlite-inspection-close-"), "source.sqlite");
  using writer = nodeSqlite.openNodeSqliteDatabase(source);
  writer.exec("CREATE TABLE probe(value TEXT)");
  const operationFailure = new Error("inspection failed");
  const closeFailure = new Error("native close failed");
  const openNative = nodeSqlite.openNodeSqliteDatabase;
  let reader: ReturnType<typeof openSqliteReadOnlyDatabase> | undefined;
  let failed = false;
  const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const db = openNative(...args);
    const nativeClose = db.close.bind(db);
    db.close = () => {
      if (db === reader && !failed) {
        failed = true;
        throw closeFailure;
      }
      nativeClose();
    };
    return db;
  });
  try {
    expect(() =>
      withArtifactPreservingStateReads(
        () => {
          reader = openSqliteReadOnlyDatabase(source);
          throw operationFailure;
        },
        { agentDatabases: true },
      ),
    ).toThrow(
      expect.objectContaining({
        cause: operationFailure,
        errors: expect.arrayContaining([operationFailure, closeFailure]),
      }),
    );
    expect(reader?.isOpen).toBe(true);
    expect(fs.existsSync(reader!.location()!)).toBe(true);
  } finally {
    open.mockRestore();
    reader?.close();
    await cleanupSnapshotOperations();
  }
});
