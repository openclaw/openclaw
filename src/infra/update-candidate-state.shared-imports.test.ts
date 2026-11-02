import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  queueStateDatabaseSpelling,
  type StateDatabaseDiscovery,
} from "./update-candidate-paths.js";

const stateDir = path.resolve("prepared-update-state");
const input = { stateDir, config: {}, env: { OPENCLAW_STATE_DIR: stateDir } };
beforeEach(() => {
  vi.resetModules();
  // mock-isolation: Fail at the unused import before loading either broad graph.
  vi.doMock("./backup-sqlite-snapshot.js", () => {
    throw new Error("prepared inventory must not load backup discovery");
  });
  // mock-isolation: Reject the snapshot barrel before its module graph can load.
  vi.doMock("../snapshot/database-backup.js", () => {
    throw new Error("schema inspection must not load snapshot operations");
  });
});
afterEach(() => {
  vi.doUnmock("./backup-sqlite-snapshot.js");
  vi.doUnmock("../snapshot/database-backup.js");
  vi.doUnmock("./database-engine/physical-store.js");
  vi.doUnmock("./sqlite-readonly-location.js");
  vi.doUnmock("./update-candidate-state.postgres.js");
  vi.restoreAllMocks();
});
// Vitest wraps factory errors; surface the import cause in JSON failure reports.
function rethrowImportCause(error: unknown): never {
  throw error instanceof Error && error.cause instanceof Error ? error.cause : error;
}

function inventory() {
  const known = path.join(stateDir, "known.sqlite");
  const alias = path.join(stateDir, "known-alias.sqlite");
  const supplemental = path.join(stateDir, "plugin.sqlite");
  const supplementalAlias = path.join(stateDir, "plugin-alias.sqlite");
  const missing = path.join(stateDir, "missing.sqlite");
  const files = new Map<string, StateDatabaseDiscovery>();
  queueStateDatabaseSpelling(files, stateDir, known);
  vi.spyOn(fs, "realpath").mockImplementation(async (file) => {
    if (file === missing) {
      throw Object.assign(new Error("missing fixture path"), { code: "ENOENT" });
    }
    return file === alias ? known : file === supplementalAlias ? supplemental : String(file);
  });
  return { files, known, alias, supplemental, supplementalAlias, missing };
}

it.each(["provided", "empty"] as const)(
  "uses %s prepared supplemental paths without importing backup discovery",
  async (kind) => {
    const { files, known, alias, supplemental, supplementalAlias, missing } = inventory();
    const additionalPaths =
      kind === "provided" ? [alias, supplemental, supplementalAlias, missing] : [];
    const { collectSupplementalStateDatabasePaths } =
      await import("./update-candidate-state.shared.js");
    expect(
      await collectSupplementalStateDatabasePaths({ ...input, additionalPaths }, files).catch(
        rethrowImportCause,
      ),
    ).toBe(files);
    expect([...files.values()].map(({ spellings }) => spellings)).toEqual(
      kind === "provided" ? [[known], [supplemental], [missing]] : [[known]],
    );
  },
);

it("discovers supplemental paths only when the prepared list is absent", async () => {
  const { files, known, alias, supplemental } = inventory();
  const discover = vi.fn().mockResolvedValue([alias, supplemental]);
  // mock-isolation: Supply discovery output without traversing real state.
  vi.doMock("./backup-sqlite-snapshot.js", () => ({ discoverBackupDatabasePaths: discover }));
  const { collectSupplementalStateDatabasePaths } =
    await import("./update-candidate-state.shared.js");
  expect(await collectSupplementalStateDatabasePaths(input, files)).toBe(files);
  expect(discover).toHaveBeenCalledOnce();
  expect(discover).toHaveBeenCalledWith({ ...input, agentRegistry: [] });
  expect([...files.values()].map(({ spellings }) => spellings)).toEqual([[known], [supplemental]]);
});

it.each(["sqlite", "postgres"] as const)(
  "classifies a header-zero %s store without importing snapshot operations",
  async (engine) => {
    const file = path.join(stateDir, "store.sqlite");
    const inspect = vi.fn().mockResolvedValue({ userVersion: 0 });
    const classify = vi
      .fn()
      .mockReturnValue(
        engine === "postgres"
          ? { engine, storeId: "fixture-store", namespace: "fixture_namespace" }
          : { engine },
      );
    const readPostgres = vi.fn().mockResolvedValue(9);
    // mock-isolation: Supply a zero header without opening SQLite or acquiring a snapshot.
    vi.doMock("./sqlite-readonly-location.js", () => ({
      inspectSqliteSchemaHeaderInProcess: inspect,
    }));
    // mock-isolation: Select the physical engine without reading a database image.
    vi.doMock("./database-engine/physical-store.js", () => ({ readBackupEngine: classify }));
    // mock-isolation: Verify dispatch without starting a worker or connecting to PostgreSQL.
    vi.doMock("./update-candidate-state.postgres.js", () => ({
      readUpdatePostgresStoreVersion: readPostgres,
    }));
    const { readUpdateStoreSchemaVersion } = await import("./update-candidate-state.shared.js");
    const options = {
      ...input,
      stagingRoot: path.join(stateDir, "staging"),
      preserveSourceArtifacts: true,
    };
    const version = await readUpdateStoreSchemaVersion(file, options).catch(rethrowImportCause);
    expect(version).toEqual({
      userVersion: engine === "postgres" ? 9 : 0,
    });
    expect(inspect).toHaveBeenCalledWith(file, options.stagingRoot, undefined, true);
    expect(classify).toHaveBeenCalledOnce();
    expect(classify).toHaveBeenCalledWith(file);
    if (engine === "postgres") {
      expect(readPostgres).toHaveBeenCalledOnce();
      expect(readPostgres).toHaveBeenCalledWith(options, file);
    } else {
      expect(readPostgres).not.toHaveBeenCalled();
    }
  },
);

it("reads a versioned SQLite header without importing an engine classifier", async () => {
  const file = path.join(stateDir, "versioned.sqlite");
  // mock-isolation: Supply a versioned header without opening SQLite or acquiring a snapshot.
  vi.doMock("./sqlite-readonly-location.js", () => ({
    inspectSqliteSchemaHeaderInProcess: vi.fn().mockResolvedValue({ userVersion: 7 }),
  }));
  // mock-isolation: Reject classification when a nonzero header makes it unnecessary.
  vi.doMock("./database-engine/physical-store.js", () => {
    throw new Error("versioned SQLite must not load physical-engine classification");
  });
  const { readUpdateStoreSchemaVersion } = await import("./update-candidate-state.shared.js");
  await expect(readUpdateStoreSchemaVersion(file, input)).resolves.toEqual({ userVersion: 7 });
});
