import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as configIo from "../config/io.js";
import * as databaseBackup from "../snapshot/database-backup.js";
import * as fileGeneration from "./sqlite-file-generation.js";
import * as sqliteIntegrity from "./sqlite-integrity.js";
import * as readOnlyLocation from "./sqlite-readonly-location.js";
import * as snapshotSource from "./sqlite-snapshot-source.js";
import * as sqliteSnapshot from "./sqlite-snapshot.js";
import { discoverUpdateStateSchemaInspectionInProcess } from "./update-candidate-state.js";
import { createUpdateDatabaseBackupInProcess } from "./update-database-backup.js";
import {
  readUpdatePhysicalDatabaseGenerations,
  readUpdatePhysicalDatabaseObservation,
} from "./update-physical-database-generations.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

const storeId = "00000000-0000-4000-8000-000000000001";
function writePostgresAnchor(file: string, namespace = "store_schema") {
  using db = new DatabaseSync(file);
  db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
  db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(
    storeId,
    namespace,
  );
}

async function fixture() {
  const root = fs.realpathSync(dirs.make("update-backup-engine-"));
  const stateDir = path.join(root, "state");
  const shared = path.join(stateDir, "state/openclaw.sqlite");
  const backupRoot = path.join(root, "backup");
  const directory = `${backupRoot}.databases`;
  const stagingRoot = path.join(root, "staging");
  for (const parent of [path.dirname(shared), directory, stagingRoot]) {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  {
    using db = new DatabaseSync(shared);
    db.exec("PRAGMA user_version=17; CREATE TABLE payload(value TEXT);");
    db.exec("INSERT INTO payload VALUES ('retained');");
  }
  const input = { backupRoot, stateDir, config: {}, env: {}, stagingRoot };
  const inspectionPlan = await discoverUpdateStateSchemaInspectionInProcess(input);
  const prepare = readOnlyLocation.prepareSqliteReadOnlyLocationSyncInProcess;
  const generationImages = vi
    .spyOn(readOnlyLocation, "prepareSqliteReadOnlyLocationSyncInProcess")
    .mockImplementation((file, _staging, ...rest) => prepare(file, stagingRoot, ...rest));
  return {
    root,
    shared,
    directory,
    stagingRoot,
    prepare,
    generationImages,
    capture: (options: Partial<Parameters<typeof createUpdateDatabaseBackupInProcess>[0]> = {}) =>
      createUpdateDatabaseBackupInProcess({ ...input, inspectionPlan, ...options }),
  };
}

it.each(["acquisition", "settlement"] as const)(
  "keeps a manual recovery image after a generation %s failure without retrying that generation",
  async (phase) => {
    const f = await fixture();
    const failure = new Error(`generation ${phase} unavailable`);
    const before = fs.readFileSync(f.shared);
    const engineImages = vi.spyOn(snapshotSource, "prepareSqliteReadOnlyLocationSync");
    if (phase === "acquisition") {
      f.generationImages.mockImplementationOnce(() => {
        throw failure;
      });
    } else {
      vi.spyOn(fileGeneration, "readStableSqliteFileGeneration").mockImplementationOnce(() => {
        throw failure;
      });
    }

    const backup = await f.capture();
    expect(engineImages.mock.calls.map(([file]) => file)).toEqual(
      phase === "acquisition" ? [f.shared] : [],
    );
    expect(f.generationImages.mock.calls.map(([file]) => file)).toEqual([f.shared, f.shared]);
    expect(backup.sourceGenerations[f.shared]).toBeUndefined();
    expect(backup.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(failure.message),
        expect.stringContaining("snapshot requires manual recovery"),
      ]),
    );
    const entry = backup.databases[0]!;
    const bytes = fs.readFileSync(entry.snapshotPath);
    expect(entry).toMatchObject({
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    using snapshot = new DatabaseSync(entry.snapshotPath, { readOnly: true });
    expect(snapshot.prepare("SELECT value FROM payload").all()).toEqual([{ value: "retained" }]);
    expect(fs.readFileSync(f.shared)).toEqual(before);
    expect(fs.readdirSync(f.stagingRoot)).toEqual([]);
  },
);

it("keeps classification errors fatal, including the private image cleanup failure", async () => {
  const f = await fixture();
  writePostgresAnchor(f.shared, "invalid-schema");
  const cleanupFailure = new Error("private image cleanup failed");
  f.generationImages.mockImplementationOnce((file, _staging, ...rest) => {
    const prepared = f.prepare(file, f.stagingRoot, ...rest);
    return {
      ...prepared,
      cleanup() {
        prepared.cleanup();
        throw cleanupFailure;
      },
    };
  });
  const before = fs.readFileSync(f.shared);
  await expect(f.capture()).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: expect.stringContaining("Invalid PostgreSQL anchor") }),
      cleanupFailure,
    ],
    cause: expect.objectContaining({
      message: expect.stringContaining("Invalid PostgreSQL anchor"),
    }),
  });
  expect(fs.readdirSync(f.directory)).toEqual([]);
  expect(fs.readdirSync(f.stagingRoot)).toEqual([]);
  expect(fs.readFileSync(f.shared)).toEqual(before);
});

it.each(["automatic", "original"] as const)(
  "admits the whole %s inventory before PostgreSQL fingerprinting or any snapshot publication",
  async (mode) => {
    const f = await fixture();
    const postgres = path.join(f.root, "z-postgres.sqlite");
    writePostgresAnchor(postgres);
    const remoteAccess = new Error("PostgreSQL access before custody admission");
    const fingerprint = vi
      .spyOn(databaseBackup, "fingerprintPostgresBackup")
      .mockRejectedValue(remoteAccess);
    const capture = vi
      .spyOn(databaseBackup, "capturePostgresBackup")
      .mockRejectedValue(remoteAccess);
    const config = vi.spyOn(configIo, "createConfigIO");
    const snapshot = vi.spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot");
    const before = [f.shared, postgres].map((file) => fs.readFileSync(file));
    await expect(
      f.capture({
        additionalPaths: [postgres],
        originalCaptureSourcePaths: mode === "original" ? [f.shared, postgres] : undefined,
      }),
    ).rejects.toThrow("PostgreSQL update capture requires exclusive ownership");
    expect(fingerprint).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(fs.readdirSync(f.directory)).toEqual([]);
    expect(fs.readdirSync(f.stagingRoot)).toEqual([]);
    expect([f.shared, postgres].map((file) => fs.readFileSync(file))).toEqual(before);
  },
);

it.each(["automatic", "original", "stopped"] as const)(
  "retains PostgreSQL before/after attribution and engine-specific integrity for admitted %s capture",
  async (mode) => {
    const f = await fixture();
    const postgres = path.join(f.root, "z-postgres.sqlite");
    writePostgresAnchor(postgres);
    const configPath = path.join(f.root, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
    const createConfigIO = configIo.createConfigIO;
    vi.spyOn(configIo, "createConfigIO").mockImplementation((options) =>
      createConfigIO({
        ...options,
        configPath,
        env: { OPENCLAW_STATE_DIR: path.join(f.root, "config-state") },
      }),
    );
    const events: string[] = [];
    const fingerprint = vi
      .spyOn(databaseBackup, "fingerprintPostgresBackup")
      .mockImplementation(async (source) => {
        expect(source).toBe(postgres);
        events.push("fingerprint");
        return "postgres-generation";
      });
    vi.spyOn(databaseBackup, "capturePostgresBackup").mockImplementation(async (params) => {
      expect(params).toMatchObject({ sourcePath: postgres, profile: "exact" });
      events.push("capture");
      return {
        schemaVersion: 2,
        snapshotId: "test-export",
        createdAt: "2026-01-01T00:00:00.000Z",
        profile: "exact",
        source: {
          engine: "postgres",
          storeId,
          owner: "test",
          namespace: "store_schema",
          schemaVersion: 0,
        },
        exportSchemaVersion: 0,
        activeFragments: [],
        verification: { tables: {}, allocations: {} },
        artifacts: {
          "database.sqlite": { sha256: "0".repeat(64), sizeBytes: 1 },
          "anchor.sqlite": { sha256: "0".repeat(64), sizeBytes: 1 },
        },
        sanitizedDifferences: [],
      };
    });
    const integrity = vi.spyOn(sqliteIntegrity, "assertSqliteIntegrity");
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const before = [f.shared, postgres].map((file) => fs.readFileSync(file));
    const backup = await f.capture({
      additionalPaths: [postgres],
      postgresOffline: true,
      stopped: mode === "stopped",
      originalCaptureSourcePaths: mode === "original" ? [f.shared, postgres] : undefined,
    });
    expect(events).toEqual(
      mode === "stopped" ? ["capture"] : ["fingerprint", "capture", "fingerprint"],
    );
    expect(fingerprint).toHaveBeenCalledTimes(mode === "stopped" ? 0 : 2);
    expect(backup.sourceGenerations[postgres]).toBe(
      mode === "stopped" ? undefined : "postgres-generation",
    );
    expect(backup.originalCaptureSourcePaths).toEqual(mode === "original" ? [f.shared] : undefined);
    if (mode === "original" || mode === "stopped") {
      expect(backup.sourceGenerations[f.shared]).toBeUndefined();
    } else {
      expect(backup.sourceGenerations[f.shared]).toEqual(expect.any(String));
    }
    for (const entry of backup.databases) {
      const calls = integrity.mock.calls.filter(([, label]) => label === entry.snapshotPath);
      expect(calls).toHaveLength(mode === "stopped" ? 0 : 1);
      if (mode !== "stopped") {
        expect(calls[0]![2]).toEqual(
          entry.path === f.shared ? { check: "full", ftsSchemas: expect.any(Array) } : undefined,
        );
      }
    }
    const checks = prepare.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => /^PRAGMA (?:quick_check|integrity_check|foreign_key_check)/u.test(sql));
    expect(checks.filter((sql) => sql.startsWith("PRAGMA integrity_check"))).toHaveLength(
      mode === "stopped" ? 0 : 2,
    );
    expect(checks.filter((sql) => sql.startsWith("PRAGMA foreign_key_check"))).toHaveLength(
      mode === "stopped" ? 0 : 2,
    );
    expect(checks.some((sql) => sql.startsWith("PRAGMA quick_check"))).toBe(false);
    expect([f.shared, postgres].map((file) => fs.readFileSync(file))).toEqual(before);
    expect(fs.readdirSync(f.stagingRoot)).toEqual([]);
  },
);

it("preserves the generic missing generation without acquiring or classifying an image", async () => {
  const f = await fixture();
  const missing = path.join(f.root, "missing.sqlite");
  expect(await readUpdatePhysicalDatabaseGenerations([missing])).toEqual({ [missing]: null });
  expect(f.generationImages).not.toHaveBeenCalled();
  expect(fs.existsSync(missing)).toBe(false);
  for (const suffix of ["-wal", "-journal"]) {
    fs.writeFileSync(missing + suffix, "retained recovery bytes");
    await expect(readUpdatePhysicalDatabaseGenerations([missing])).rejects.toThrow(
      "Database is absent but retained journal data exists",
    );
    expect(fs.readFileSync(missing + suffix, "utf8")).toBe("retained recovery bytes");
    fs.unlinkSync(missing + suffix);
  }
  expect(f.generationImages).not.toHaveBeenCalled();
});

it("retains only engine classification after settlement fails and preserves the generic error", async () => {
  const f = await fixture();
  const failure = new Error("generation settlement failed");
  vi.spyOn(fileGeneration, "readStableSqliteFileGeneration").mockImplementation(() => {
    throw failure;
  });
  expect(readUpdatePhysicalDatabaseObservation(f.shared)).toEqual({
    engine: { engine: "sqlite" },
    generation: { ok: false, error: failure },
  });
  await expect(readUpdatePhysicalDatabaseGenerations([f.shared])).rejects.toBe(failure);
  expect(fs.readdirSync(f.stagingRoot)).toEqual([]);
});
