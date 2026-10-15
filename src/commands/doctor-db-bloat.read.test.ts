import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteSnapshotCleanupError } from "../infra/sqlite-readonly-location-cleanup.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { readSqliteDatabaseBloat } from "./doctor-db-bloat.read.js";

vi.mock("../state/openclaw-agent-db-registry-listing.js", () => ({
  readRegisteredAgentDatabases: () => [],
}));

afterEach(() => vi.restoreAllMocks());

it.each([
  { error: new Error("unavailable read"), cleanup: false },
  { error: new SqliteSnapshotCleanupError("incomplete cleanup"), cleanup: true },
])("preserves cleanup failure=$cleanup without opening SQLite", ({ error, cleanup }) => {
  const prepare = vi
    .spyOn(snapshots, "prepareSqliteReadOnlyLocationSync")
    .mockImplementation(() => {
      throw error;
    });
  // Only stat the test source; the controlled preparation error prevents any database open.
  const read = () => readSqliteDatabaseBloat({ path: fileURLToPath(import.meta.url), env: {} });
  if (cleanup) {
    expect(read).toThrow(error);
  } else {
    expect(read()).toEqual([]);
  }
  expect(prepare).toHaveBeenCalledOnce();
});
