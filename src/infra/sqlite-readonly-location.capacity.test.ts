import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  prepareSqliteReadOnlyCopyInProcess,
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });
});

function createTempDatabasePath(sql: string): string {
  const pathname = path.join(tempDirs.make("sqlite-capacity-source-"), "source.sqlite");
  using database = new (requireNodeSqlite().DatabaseSync)(pathname);
  database.exec(sql);
  return pathname;
}

it.each([
  ["synchronous copy", prepareSqliteReadOnlyLocationSyncInProcess],
  ["asynchronous copy", prepareSqliteReadOnlyCopyInProcess],
  ["online backup", prepareSqliteReadOnlyLocationInProcess],
] as const)("refuses an undersized cache before an 8.4 GB %s", async (_mode, prepare) => {
  const databasePath = createTempDatabasePath("CREATE TABLE probe(value);");
  const stagingRoot = tempDirs.make("sqlite-snapshot-capacity-");
  const original = fs.readFileSync(databasePath);
  // Advertise the reported database size without allocating or reading gigabytes in this fixture.
  const stat = fs.statSync.bind(fs);
  vi.spyOn(fs, "statSync").mockImplementation((...args) => {
    const result = stat(...args);
    return String(args[0]) === databasePath && result && typeof result.size === "number"
      ? Object.assign(result, { size: 8_400_000_000 })
      : result;
  });
  const space = fs.statfsSync(stagingRoot);
  vi.spyOn(fs, "statfsSync").mockReturnValue(
    Object.assign(space, { bsize: 1, bavail: 1_000_000_000 }),
  );
  let prepared: Awaited<ReturnType<typeof prepare>> | undefined;
  try {
    await expect(
      Promise.resolve()
        .then(() => prepare(databasePath, stagingRoot))
        .then((location) => (prepared = location)),
    ).rejects.toThrow(/8400000000 bytes.*1000000000 bytes.*[Ff]ree disk space/s);
  } finally {
    await prepared?.cleanupAsync();
  }
  expect(fs.readFileSync(databasePath)).toEqual(original);
  expect(fs.readdirSync(stagingRoot)).toEqual([]);
});
