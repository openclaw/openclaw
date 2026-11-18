import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import * as fileGeneration from "./sqlite-file-generation.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";
import {
  getUpdateDoctorMigrationSource,
  runUpdateSqliteMigration,
} from "./update-doctor-migration-context.js";
import { createUpdateDoctorDatabaseWriteCapture } from "./update-doctor-result.js";

// Outside read-only opens rebuild a retained WAL index without committing (#197083).
const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture(relative: string, sql: string) {
  const root = fs.realpathSync(directories.make("captured-migration-"));
  const pathname = path.join(root, relative);
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "alias") };
  fs.symlinkSync(root, env.OPENCLAW_STATE_DIR, "junction");
  using database = new DatabaseSync(pathname);
  database.exec(`PRAGMA journal_mode=WAL; CREATE TABLE retained(value); ${sql}`);
  return { pathname, env };
}

function migrate(database: DatabaseSync, pathname: string) {
  const alias = path.join(path.dirname(pathname), "alias", path.basename(pathname));
  runUpdateSqliteMigration(database, alias, () => {
    expect(getUpdateDoctorMigrationSource(alias)?.path).toBe(alias);
    database.exec("ALTER TABLE retained ADD COLUMN migrated;");
  });
}

async function withCapture(
  env: NodeJS.ProcessEnv,
  generations: ReturnType<typeof readUpdateDatabaseGenerations>,
  operation: () => Promise<void>,
  admissions: readonly (() => void)[] = [],
) {
  const warnings: string[] = [];
  const capture = createUpdateDoctorDatabaseWriteCapture(generations, {
    env,
    signal: new AbortController().signal,
    warn: (message) => warnings.push(message),
  })!;
  const scope = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: () => {},
    assertDatabaseAccess: () => {},
  });
  try {
    await capture.admit();
    // Finalization, predecessor stop and maintenance each admit the same capture.
    for (const between of admissions) {
      between();
      await capture.admit();
    }
    await scope.run(() => capture.run(operation));
    await scope.close();
    await capture.settle();
    return { receipt: capture.receipt, warnings };
  } finally {
    try {
      await scope.close();
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  }
}

it.each(["while Doctor reads it", "after admission", "after a same-content commit"] as const)(
  "attributes a migration when an outside reader rebuilds retained WAL frames %s",
  async (timing) => {
    const { pathname, env } = fixture("source.sqlite", "INSERT INTO retained VALUES (7);");
    const read = (database: DatabaseSync) => database.prepare("SELECT value FROM retained").all();
    // A reader that outlives the last writer keeps its frames and live index.
    const keep = (write: string) => {
      const reader = new DatabaseSync(pathname, { readOnly: true });
      read(reader);
      const writer = new DatabaseSync(pathname);
      writer.exec(write);
      writer.close();
      reader.close();
    };
    keep("INSERT INTO retained VALUES (8);");
    const generations = readUpdateDatabaseGenerations([pathname]);
    const rebuild = () => {
      using reader = new DatabaseSync(pathname, { readOnly: true });
      read(reader);
    };
    const { receipt, warnings } = await withCapture(env, generations, async () => {
      if (timing === "while Doctor reads it") {
        const stable = fileGeneration.readStableSqliteFileGeneration;
        vi.spyOn(fileGeneration, "readStableSqliteFileGeneration").mockImplementationOnce(
          (...args) => {
            const generation = stable(...args);
            rebuild();
            return generation;
          },
        );
      } else {
        if (timing === "after a same-content commit") {
          keep("UPDATE retained SET value = 9; UPDATE retained SET value = 8;");
        }
        rebuild();
      }
      const change = fs.readFileSync(`${pathname}-shm`).readUInt32LE(8);
      expect(change === 0).toBe(timing !== "while Doctor reads it");
      using database = new DatabaseSync(pathname);
      if (timing === "after a same-content commit") {
        expect(() => migrate(database, pathname)).toThrow(
          "SQLite migration source changed after update capture:",
        );
        return;
      }
      migrate(database, pathname);
      expect(read(database)).toEqual([{ value: 7 }, { value: 8 }]);
    });
    if (timing === "after a same-content commit") {
      expect(receipt).toMatchObject({ unchanged: false });
      return;
    }
    expect(warnings).toEqual([]);
    expect(receipt).toMatchObject({ unchanged: true, fromGenerations: generations });
  },
);

it("keeps a rebuilt WAL index attributable across repeated Doctor admissions", async () => {
  const { pathname, env } = fixture("source.sqlite", "INSERT INTO retained VALUES (7);");
  const read = (database: DatabaseSync) => database.prepare("SELECT value FROM retained").all();
  // A reader that outlives the last writer keeps its frames and live index.
  const reader = new DatabaseSync(pathname, { readOnly: true });
  read(reader);
  const writer = new DatabaseSync(pathname);
  writer.exec("INSERT INTO retained VALUES (8);");
  writer.close();
  reader.close();
  const generations = readUpdateDatabaseGenerations([pathname]);
  const rebuild = () => {
    using rebuilt = new DatabaseSync(pathname, { readOnly: true });
    read(rebuilt);
  };
  const { receipt, warnings } = await withCapture(
    env,
    generations,
    async () => {
      using database = new DatabaseSync(pathname);
      migrate(database, pathname);
    },
    [rebuild],
  );
  expect(warnings).toEqual([]);
  expect(receipt).toMatchObject({ unchanged: true, fromGenerations: generations });
});
