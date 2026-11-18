import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { execNodeEvalSync } from "../test-utils/node-process.js";
import { readUpdateDatabaseGeneration } from "./update-database-generations.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function commitMigrationWithRetainedWal() {
  const directory = dirs.make("update-generation-retained-wal-");
  vi.stubEnv("OPENCLAW_STATE_DIR", directory);
  vi.stubEnv("XDG_CACHE_HOME", directory);
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
  const file = path.join(directory, "agent.sqlite");
  {
    using keeper = new DatabaseSync(file);
    keeper.exec("PRAGMA journal_mode=WAL; CREATE TABLE receipt(value);");
  }
  {
    using keeper = new DatabaseSync(file, { readOnly: true });
    keeper.prepare("SELECT value FROM receipt").all();
    // The reader outlives the writer, so the next open rebuilds the retained index.
    using migration = new DatabaseSync(file);
    migration.exec("ALTER TABLE receipt ADD COLUMN migrated;");
  }
  const wal = fs.readFileSync(`${file}-wal`);
  const header = fs.readFileSync(`${file}-shm`).subarray(0, 48);
  expect(wal.length).toBeGreaterThan(32);
  expect(header.readUInt32LE(8)).not.toBe(0);
  return { file, wal, header, database: fs.readFileSync(file) };
}

// This fixture uses the Linux VFS's last-reader close and WAL-index rebuild.
it.skipIf(process.platform !== "linux")(
  "verifies publication when a read-only reopen rebuilds a retained WAL index",
  () => {
    const { file, wal, header, database } = commitMigrationWithRetainedWal();
    const observation = readUpdateDatabaseGeneration(file, () => {
      execNodeEvalSync(
        `
          import { DatabaseSync } from "node:sqlite";
          using reader = new DatabaseSync(${JSON.stringify(file)}, { readOnly: true });
          reader.prepare("SELECT migrated FROM receipt").all();
        `,
        { timeout: 5_000 },
      );
      const rebuilt = fs.readFileSync(`${file}-shm`).subarray(0, 48);
      expect(rebuilt.readUInt32LE(8)).toBe(0);
      expect(rebuilt.subarray(24, 32)).toEqual(header.subarray(24, 32));
      expect(fs.readFileSync(file)).toEqual(database);
      expect(fs.readFileSync(`${file}-wal`)).toEqual(wal);
    });
    expect(observation).toEqual(readUpdateDatabaseGeneration(file));
  },
);

it.skipIf(process.platform !== "linux")(
  "refuses publication when an outside writer commits to the retained WAL",
  () => {
    const { file, wal, database } = commitMigrationWithRetainedWal();
    expect(() =>
      readUpdateDatabaseGeneration(file, () => {
        execNodeEvalSync(
          `
            import { DatabaseSync } from "node:sqlite";
            const file = ${JSON.stringify(file)};
            using keeper = new DatabaseSync(file, { readOnly: true });
            keeper.prepare("SELECT migrated FROM receipt").all();
            using writer = new DatabaseSync(file);
            writer.exec("INSERT INTO receipt VALUES ('outside', 1)");
          `,
          { timeout: 5_000 },
        );
        expect(fs.readFileSync(file)).toEqual(database);
        expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(wal.length);
      }),
    ).toThrow(/SQLite file generation changed while reading/);
    using reader = new DatabaseSync(file, { readOnly: true });
    expect(reader.prepare("SELECT migrated FROM receipt WHERE value = 'outside'").get()).toEqual({
      migrated: 1,
    });
  },
);
