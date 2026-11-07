import fs from "node:fs";
import path from "node:path";
import * as fsSafeAdvanced from "@openclaw/fs-safe/advanced";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import * as sqliteCopy from "./sqlite-file-copy.js";
import {
  prepareSqliteReadOnlyCopyInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";

vi.mock("@openclaw/fs-safe/advanced", { spy: true });
const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("copies inspection snapshots without sharing source extents", async () => {
  const directory = directories.make("sqlite-inspection-transfer-");
  const sourcePath = path.join(directory, "source.sqlite");
  const stagingRoot = path.join(directory, "staging");
  fs.mkdirSync(stagingRoot);
  {
    using database = new (requireNodeSqlite().DatabaseSync)(sourcePath);
    database.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('kept');");
  }
  const source = fs.readFileSync(sourcePath);
  const syncCopy = vi.mocked(fsSafeAdvanced.copyRootFileSync);
  syncCopy.mockClear();
  const transfer = vi.spyOn(sqliteCopy, "copySqliteFile");
  for (const mode of ["sync", "async"] as const) {
    const prepared =
      mode === "sync"
        ? prepareSqliteReadOnlyLocationSyncInProcess(sourcePath, stagingRoot)
        : await prepareSqliteReadOnlyCopyInProcess(sourcePath, stagingRoot);
    try {
      using database = new (requireNodeSqlite().DatabaseSync)(prepared.location, {
        readOnly: true,
      });
      expect(database.prepare("SELECT value FROM probe").get()).toEqual({ value: "kept" });
    } finally {
      expect(prepared.cleanup()).toBe(true);
    }
    expect(fs.readFileSync(sourcePath)).toEqual(source);
    expect(fs.readdirSync(stagingRoot)).toEqual([]);
  }
  // The dependency's actual byte-copy result excludes reflink and copy offload.
  expect(syncCopy).toHaveBeenCalled();
  expect(
    syncCopy.mock.results.every(
      (result) => result.type === "return" && result.value.method === "copy",
    ),
  ).toBe(true);
  expect(transfer).toHaveBeenCalled();
  expect(transfer.mock.calls.every((call) => call[3]?.clone === "never")).toBe(true);
});
