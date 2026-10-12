import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import * as sqliteVec from "../../packages/memory-host-sdk/src/host/sqlite-vec.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "preserves vec0 data without loading native extensions (preserveRowIds=%s)",
  async (preserveRowIds) => {
    const directory = fs.realpathSync(directories.make("sqlite-snapshot-vector-"));
    const sourcePath = path.join(directory, "source.sqlite");
    const targetPath = path.join(directory, "snapshot.sqlite");
    const source = openNodeSqliteDatabase(sourcePath, { allowExtension: true });
    try {
      expect(await sqliteVec.loadSqliteVecExtension({ db: source })).toMatchObject({ ok: true });
      source.exec(`
        CREATE VIRTUAL TABLE vectors USING vec0(embedding float[3]);
        INSERT INTO vectors(rowid, embedding) VALUES(42, '[1,2,3]');
        CREATE TABLE records(value TEXT);
        INSERT INTO records VALUES('before');
        PRAGMA user_version = 7;
      `);
    } finally {
      source.close();
    }
    const original = fs.readFileSync(sourcePath);
    const load = vi
      .spyOn(sqliteVec, "loadSqliteVecExtension")
      .mockRejectedValue(new Error("sqlite-vec cannot load on this CPU"));
    const validate = vi.fn((database: DatabaseSync) => {
      expect(database.prepare("SELECT count(*) AS count FROM records").get()).toEqual({
        count: 1,
      });
    });
    const snapshot = await createVerifiedSqliteSnapshot({
      sourcePath,
      targetPath,
      preserveRowIds,
      ...(preserveRowIds
        ? { sourceAcquisition: { mode: "isolated-process" as const, stagingRoot: directory } }
        : {}),
      transform: (database) => {
        database.exec("UPDATE records SET value = 'transformed';");
      },
      validate,
    });
    expect(load).not.toHaveBeenCalled();
    load.mockRestore();
    expect(validate).toHaveBeenCalledTimes(3);
    expect(snapshot).toMatchObject({ path: targetPath, userVersion: 7 });
    expect(fs.readFileSync(sourcePath)).toEqual(original);
    const restored = openNodeSqliteDatabase(targetPath, { readOnly: true, allowExtension: true });
    try {
      expect(restored.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(restored.prepare("SELECT value FROM records").get()).toEqual({ value: "transformed" });
      expect(await sqliteVec.loadSqliteVecExtension({ db: restored })).toMatchObject({ ok: true });
      expect(
        restored.prepare("SELECT rowid, vec_to_json(embedding) AS embedding FROM vectors").get(),
      ).toEqual({ rowid: 42, embedding: "[1.000000,2.000000,3.000000]" });
    } finally {
      restored.close();
    }
  },
);
