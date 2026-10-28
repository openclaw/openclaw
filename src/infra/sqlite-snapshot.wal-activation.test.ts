import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
});

it.each(["reader", "writer"] as const)(
  "publishes a verified snapshot when a %s activates a closed WAL source during copying",
  async (activity) => {
    const directory = fs.realpathSync(directories.make("sqlite-snapshot-wal-activation-"));
    const sourcePath = path.join(directory, "source.sqlite");
    const targetPath = path.join(directory, "snapshot.sqlite");
    const sqlite = requireNodeSqlite();
    const seed = new sqlite.DatabaseSync(sourcePath);
    try {
      seed.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE update_runs (updated_at_ms INTEGER NOT NULL);
        INSERT INTO update_runs VALUES (1);
      `);
    } finally {
      seed.close();
    }
    expect(fs.existsSync(`${sourcePath}-wal`)).toBe(false);
    expect(fs.existsSync(`${sourcePath}-shm`)).toBe(false);
    const original = fs.readFileSync(sourcePath);
    let connection: DatabaseSync | undefined;
    __setFsSafeTestHooksForTest({
      beforeRootStatObservation: (root) => {
        if (root !== directory || connection) {
          return;
        }
        // The raw copy has already classified the source as an inactive WAL family.
        connection = new sqlite.DatabaseSync(sourcePath, { readOnly: activity === "reader" });
        if (activity === "writer") {
          connection.exec("UPDATE update_runs SET updated_at_ms = 2;");
        } else {
          connection.prepare("SELECT updated_at_ms FROM update_runs").get();
        }
        expect(fs.existsSync(`${sourcePath}-wal`)).toBe(true);
        expect(fs.existsSync(`${sourcePath}-shm`)).toBe(true);
      },
    });

    try {
      await createVerifiedSqliteSnapshot({
        sourcePath,
        targetPath,
        sourceAcquisition: { mode: "isolated-process", stagingRoot: directory },
      });
      expect(connection).toBeDefined();
      // The writer's commit lives only in WAL; publishing the first raw copy loses it.
      expect(fs.readFileSync(sourcePath)).toEqual(original);
      const snapshot = new sqlite.DatabaseSync(targetPath, { readOnly: true });
      try {
        expect(snapshot.prepare("SELECT updated_at_ms FROM update_runs").get()).toEqual({
          updated_at_ms: activity === "writer" ? 2 : 1,
        });
        expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
      } finally {
        snapshot.close();
      }
      expect(fs.readdirSync(directory).toSorted()).toEqual([
        "snapshot.sqlite",
        "source.sqlite",
        "source.sqlite-shm",
        "source.sqlite-wal",
      ]);
    } finally {
      __setFsSafeTestHooksForTest(undefined);
      connection?.close();
    }
  },
);
