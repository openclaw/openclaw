import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as configIo from "../config/io.js";
import * as databaseBackup from "../snapshot/database-backup.js";
import * as fileDescriptor from "./file-descriptor.js";
import * as fileGeneration from "./sqlite-file-generation.js";
import * as sqliteIntegrity from "./sqlite-integrity.js";
import { cleanupSnapshotOperations } from "./sqlite-readonly-location-cleanup.js";
import * as readOnlyLocation from "./sqlite-readonly-location.js";
import * as snapshotSource from "./sqlite-snapshot-source.js";
import * as sqliteSnapshot from "./sqlite-snapshot.js";
import * as walCheckpoint from "./sqlite-wal-checkpoint.js";
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

it.each(["auto", "off"] as const)(
  "does not recapture verified generation bytes with native copying %s",
  async (mode) => {
    const f = await fixture();
    const payload = path.join(f.root, "payload.sqlite");
    {
      using db = new DatabaseSync(payload);
      db.exec(
        "PRAGMA user_version=17; CREATE TABLE payload(value BLOB); INSERT INTO payload VALUES (zeroblob(2097152));",
      );
    }
    const before = fs.readFileSync(payload);
    const source = fs.statSync(payload, { bigint: true });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_000);
    const originalRead = fs.readSync;
    let privateReadBytes = 0;
    let privateHashes = 0;
    const hash = fileDescriptor.hashFileDescriptorSync;
    vi.spyOn(fileDescriptor, "hashFileDescriptorSync").mockImplementation((descriptor) => {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (opened.size === source.size && (opened.dev !== source.dev || opened.ino !== source.ino)) {
        privateHashes++;
      }
      return hash(descriptor);
    });
    vi.spyOn(fs, "readSync").mockImplementation(
      (
        descriptor: number,
        buffer: NodeJS.ArrayBufferView,
        offsetOrOptions: number | fs.ReadOptions = {},
        length?: number,
        position?: fs.ReadPosition | null,
      ) => {
        const options =
          typeof offsetOrOptions === "number"
            ? { offset: offsetOrOptions, length, position }
            : offsetOrOptions;
        const count = originalRead(descriptor, buffer, options);
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (
          opened.isFile() &&
          opened.size === source.size &&
          (opened.dev !== source.dev || opened.ino !== source.ino)
        ) {
          privateReadBytes += count;
        }
        return count;
      },
    );
    const previous = getFsSafeNativeConfig();
    configureFsSafeNative({ mode });
    let backup: Awaited<ReturnType<typeof f.capture>>;
    try {
      backup = await f.capture({ additionalPaths: [payload], preserveSourceArtifacts: true });
    } finally {
      configureFsSafeNative(previous);
    }
    // Fresh source-family verification reuses the first committed receipt;
    // neither snapshot publication nor its after-check needs another image hash.
    expect(f.generationImages.mock.calls.filter(([file]) => file === payload)).toHaveLength(1);
    expect(privateHashes).toBe(1);
    expect(privateReadBytes).toBeGreaterThanOrEqual(before.length);
    expect(privateReadBytes).toBeLessThanOrEqual(before.length + 512);
    const entry = backup.databases.find((database) => database.path === payload);
    expect(entry).toMatchObject({
      userVersion: 17,
      sizeBytes: before.length,
      sha256: createHash("sha256").update(before).digest("hex"),
    });
    expect(backup.sourceGenerations[payload]).toEqual(expect.any(String));
    expect(backup.warnings).toEqual([]);
    expect(fs.readFileSync(entry!.snapshotPath).equals(before), "snapshot bytes").toBe(true);
    expect(fs.readFileSync(payload).equals(before), "source bytes").toBe(true);
    expect(fs.readdirSync(f.stagingRoot)).toEqual([]);
  },
);

it("retains the admitted inventory through cleanup and consumes each image without recapture", async () => {
  const f = await fixture();
  const second = path.join(f.root, "z-second.sqlite");
  fs.copyFileSync(f.shared, second);
  const prepared = new Map<string, string>();
  f.generationImages.mockImplementation((file, _staging, ...rest) => {
    const image = f.prepare(file, f.stagingRoot, ...rest);
    if (!prepared.has(file)) {
      prepared.set(file, image.location);
    }
    return image;
  });
  const capture = sqliteSnapshot.createVerifiedSqliteSnapshot;
  const transferred: string[] = [];
  vi.spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot").mockImplementation(async (options) => {
    const image = options.sourceAcquisition?.preparedSource;
    expect(image?.prepared.location).toBe(prepared.get(options.sourcePath));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(image && fs.existsSync(image.prepared.location)).toBe(true);
    transferred.push(options.sourcePath);
    return capture(options);
  });
  let cleanup: Promise<void> | undefined;
  const backup = await f.capture({
    additionalPaths: [second],
    onProgress: () => {
      expect(prepared.size).toBe(2);
      cleanup ??= cleanupSnapshotOperations();
    },
  });
  await cleanup;
  expect(transferred.toSorted()).toEqual([f.shared, second].toSorted());
  expect(backup.warnings).toEqual([]);
  expect(
    Object.entries(backup.sourceGenerations)
      .filter(([, value]) => value !== null)
      .map(([file]) => file)
      .toSorted(),
  ).toEqual(transferred.toSorted());
  for (const file of backup.missingPaths) {
    expect(backup.sourceGenerations[file]).toBeNull();
  }
  expect(fs.readdirSync(f.stagingRoot)).toEqual([]);
});

it.each(["replace", "same-size-write", "wal", "journal"] as const)(
  "refuses a retained image %s without reacquiring or publishing it",
  async (change) => {
    const f = await fixture();
    const capture = sqliteSnapshot.createVerifiedSqliteSnapshot;
    const reacquire = vi.spyOn(readOnlyLocation, "prepareSqliteReadOnlyCopyInProcess");
    vi.spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot").mockImplementationOnce((options) => {
      const image = options.sourceAcquisition?.preparedSource?.prepared.location;
      expect(image).toEqual(expect.any(String));
      if (!image) {
        throw new Error("Expected the admitted generation image");
      }
      if (change === "replace") {
        const replacement = `${image}.replacement`;
        fs.copyFileSync(image, replacement);
        fs.renameSync(replacement, image);
      } else if (change === "same-size-write") {
        const before = fs.statSync(image);
        const bytes = fs.readFileSync(image);
        bytes.write("replaced", bytes.indexOf("retained"));
        fs.writeFileSync(image, bytes);
        fs.utimesSync(image, before.atime, before.mtime);
      } else {
        fs.writeFileSync(`${image}-${change}`, Buffer.alloc(64));
      }
      return capture(options);
    });
    await expect(f.capture()).rejects.toThrow("prepared source changed before transfer");
    expect(reacquire).not.toHaveBeenCalled();
    expect(f.generationImages).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(f.stagingRoot)).toEqual([]);
  },
);

it.each(["new content", "same-content WAL commit"] as const)(
  "keeps the captured image but refuses automatic rollback after a later %s",
  async (write) => {
    const f = await fixture();
    using writer = new DatabaseSync(f.shared);
    if (write === "same-content WAL commit") {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    }
    let wrote = false;
    const backup = await f.capture({
      onProgress: ({ phase }) => {
        if (wrote || phase !== "pre-migration database backup") {
          return;
        }
        wrote = true;
        // Keep the writer open so WAL commit identity survives even when rows match.
        writer.exec("UPDATE payload SET value = 'new-value';");
        if (write === "same-content WAL commit") {
          writer.exec("UPDATE payload SET value = 'retained';");
        }
      },
    });
    expect(wrote).toBe(true);
    expect(backup.sourceGenerations[f.shared]).toBeUndefined();
    expect(backup.warnings).toContainEqual(
      expect.stringContaining("snapshot requires manual recovery"),
    );
    using captured = new DatabaseSync(backup.databases[0]!.snapshotPath, { readOnly: true });
    expect(captured.prepare("SELECT value FROM payload").get()).toEqual({ value: "retained" });
    using source = new DatabaseSync(f.shared, { readOnly: true });
    expect(source.prepare("SELECT value FROM payload").get()).toEqual({
      value: write === "new content" ? "new-value" : "retained",
    });
    expect(f.generationImages).toHaveBeenCalledTimes(2);
  },
);

it("reacquires a metadata-drifted family and retains unchanged committed authority", async () => {
  const f = await fixture();
  const backup = await f.capture({
    onProgress: ({ phase }) => {
      if (phase === "pre-migration database backup") {
        const before = fs.statSync(f.shared);
        fs.utimesSync(f.shared, before.atime, new Date(before.mtimeMs + 1_000));
      }
    },
  });
  expect(f.generationImages).toHaveBeenCalledTimes(2);
  expect(backup.sourceGenerations[f.shared]).toEqual(expect.any(String));
  expect(backup.warnings).toEqual([]);
  expect(fs.readdirSync(f.stagingRoot)).toEqual([]);
});

it("keeps manual recovery after fresh after-capture observation fails without reacquisition", async () => {
  const f = await fixture();
  const failure = new Error("fresh source-family observation unavailable");
  const capture = sqliteSnapshot.createVerifiedSqliteSnapshot;
  vi.spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot").mockImplementationOnce(
    async (options) => {
      const snapshot = await capture(options);
      vi.spyOn(fileGeneration, "readStableSqliteFileGeneration").mockImplementationOnce(() => {
        throw failure;
      });
      return snapshot;
    },
  );
  const backup = await f.capture();
  expect(f.generationImages).toHaveBeenCalledTimes(1);
  expect(backup.sourceGenerations[f.shared]).toBeUndefined();
  expect(backup.warnings).toEqual(
    expect.arrayContaining([
      expect.stringContaining(failure.message),
      expect.stringContaining("snapshot requires manual recovery"),
    ]),
  );
  using snapshot = new DatabaseSync(backup.databases[0]!.snapshotPath, { readOnly: true });
  expect(snapshot.prepare("SELECT value FROM payload").all()).toEqual([{ value: "retained" }]);
  expect(fs.readdirSync(f.stagingRoot)).toEqual([]);
});

it.each(["success", "false", "throw"] as const)(
  "joins every retained image after admission fails and preserves cleanup %s",
  async (cleanup) => {
    const f = await fixture();
    const second = path.join(f.root, "z-second.sqlite");
    fs.copyFileSync(f.shared, second);
    const failure = new Error("capture cancelled before publication");
    const cleanupFailure = new Error("retained cleanup refused");
    let retired = 0;
    f.generationImages.mockImplementation((file, _staging, ...rest) => {
      const prepared = f.prepare(file, f.stagingRoot, ...rest);
      return {
        ...prepared,
        async cleanupAsync() {
          const result = await prepared.cleanupAsync();
          retired++;
          if (cleanup === "throw") {
            throw cleanupFailure;
          }
          return cleanup === "false" ? false : result;
        },
      };
    });
    const pending = f.capture({
      additionalPaths: [second],
      onProgress: () => {
        throw failure;
      },
    });
    if (cleanup === "success") {
      await expect(pending).rejects.toBe(failure);
    } else {
      await expect(pending).rejects.toMatchObject({
        cause: failure,
        errors: [failure, expect.any(Error), expect.any(Error)],
      });
    }
    expect(retired).toBe(2);
    expect(fs.readdirSync(f.directory)).toEqual([]);
    expect(fs.readdirSync(f.stagingRoot)).toEqual([]);
  },
);

it.each([
  ["before-classification", "false"],
  ["before-classification", "throw"],
  ["postgres", "false"],
  ["postgres", "throw"],
] as const)("refuses %s capture when acquired-image cleanup returns %s", async (phase, outcome) => {
  const f = await fixture();
  const failure = new Error("checkpoint refused before classification");
  const cleanupFailure = new Error("generation cleanup refused");
  if (phase === "postgres") {
    writePostgresAnchor(f.shared);
  } else {
    vi.spyOn(walCheckpoint, "truncateSqliteWal").mockImplementationOnce(() => {
      throw failure;
    });
  }
  f.generationImages.mockImplementationOnce((file, _staging, ...rest) => {
    const prepared = f.prepare(file, f.stagingRoot, ...rest);
    return {
      ...prepared,
      cleanup() {
        prepared.cleanup();
        if (outcome === "throw") {
          throw cleanupFailure;
        }
        return false;
      },
    };
  });
  const reacquire = vi.spyOn(snapshotSource, "prepareSqliteReadOnlyLocationSync");
  const publish = vi.spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot");
  const captured = await f.capture().catch((error: unknown) => error);
  expect(captured).toBeInstanceOf(Error);
  const causes = collectNestedErrorCandidates(captured);
  expect(causes).toContainEqual(
    expect.objectContaining({ message: "Database generation snapshot cleanup failed" }),
  );
  if (phase === "before-classification") {
    expect(causes).toContain(failure);
  }
  if (outcome === "throw") {
    expect(causes).toContain(cleanupFailure);
  }
  expect(reacquire).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(f.generationImages).toHaveBeenCalledTimes(1);
  expect(fs.readdirSync(f.stagingRoot)).toEqual([]);
});

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
      expect.objectContaining({ cause: cleanupFailure }),
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
