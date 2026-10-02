import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLoggerOverride } from "../logging/logger.js";
import { testApi } from "../logging/logger.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  adoptPreparedLocation,
  removeTempDirectory,
  SqliteSnapshotCleanupError,
  type CleanupFailureReport,
} from "./sqlite-readonly-location-cleanup.js";
import {
  prepareSqliteReadOnlyLocation,
  startSqliteReadOnlyLocationAsync,
} from "./sqlite-snapshot-source.js";
import * as staging from "./sqlite-snapshot-staging.js";

function createDatabase(location: string, sql: string): Buffer {
  const database = new (requireNodeSqlite().DatabaseSync)(location);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
  return fs.readFileSync(location);
}

function createSnapshot(name: string) {
  const ownedRoot = path.join(root, name);
  const location = path.join(ownedRoot, "database.sqlite");
  fs.mkdirSync(ownedRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(location, "snapshot bytes");
  return { ownedRoot, location };
}

it("preserves failed cleanup over cancellation in the public preparation contract", async () => {
  const directory = path.join(root, "cancelled-preparation");
  await fs.promises.mkdir(directory);
  const prepared = adoptPreparedLocation(path.join(directory, "database.sqlite"), directory);
  const controller = new AbortController();
  vi.spyOn(staging, "createSqliteSnapshotStagingDirectory").mockImplementation(async () => {
    controller.abort(new Error("caller cancelled"));
    return directory;
  });
  const remove = vi.spyOn(fs.promises, "rm").mockRejectedValueOnce(new Error("snapshot busy"));
  try {
    await expect(
      prepareSqliteReadOnlyLocation(path.join(root, "unused.sqlite"), {
        signal: controller.signal,
      }),
    ).rejects.toThrow("snapshot cleanup failed");
    expect(fs.existsSync(directory)).toBe(true);
  } finally {
    remove.mockRestore();
    expect(await prepared.cleanupAsync()).toBe(true);
  }
});

it.each([
  { targetLost: false, outcome: "replacement bytes after completed removal" },
  { targetLost: true, outcome: "original reader custody after target loss" },
])("retains $outcome across cleanup module reload", async ({ targetLost }) => {
  const oldCleanup = await import("./sqlite-readonly-location-cleanup.js");
  const oldStaging = await import("./sqlite-snapshot-staging.js");
  const { captureSqliteSnapshotStagingOwner } = await import("./sqlite-snapshot-staging-owner.js");
  const { resolveRuntimeProcessEntrypointUrl } = await import("./runtime-process-url.js");
  const { captureRuntimeWorkerSource, withRuntimeWorkerGeneration } =
    await import("./runtime-worker-generation.js");
  const { captureRetainedNativeWorkerSource } = await import("./worker-native-lifecycle.js");
  const stagingUrl = resolveRuntimeProcessEntrypointUrl("sqliteSnapshotStaging");
  let generationReleased = false;
  await withRuntimeWorkerGeneration(
    async (bind) => {
      bind((url) => {
        if (url.href !== stagingUrl.href) {
          return url;
        }
        const retained = new URL(url);
        retained.searchParams.set("snapshot-test-generation", "cleanup-module-reload");
        return retained;
      });
      const captured = captureRuntimeWorkerSource(stagingUrl);
      expect(captured.runtimeGeneration).toBeDefined();
      const nativeSource = captureRetainedNativeWorkerSource({
        runtimeGeneration: captured.runtimeGeneration,
      });
      const owner = captureSqliteSnapshotStagingOwner();
      const prime = await oldStaging.createSqliteSnapshotStagingDirectory(
        root,
        false,
        undefined,
        true,
      );
      expect(await oldCleanup.removeTempDirectoryAsync(prime)).toBe(true);
      expect(fs.existsSync(prime)).toBe(false);
      // Observe the existing source factory without substituting its handle or resource descriptor.
      const constructions = vi.spyOn(nativeSource, "create");
      try {
        vi.resetModules();
        const currentCleanup = await import("./sqlite-readonly-location-cleanup.js");
        const currentStaging = await import("./sqlite-snapshot-staging.js");
        const currentOwner = await import("./sqlite-snapshot-staging-owner.js");
        expect(currentOwner.captureSqliteSnapshotStagingOwner()).toBe(owner);
        const directory = await currentStaging.createSqliteSnapshotStagingDirectory(
          root,
          false,
          undefined,
          true,
        );
        const targetIndex = constructions.mock.calls.findIndex(
          ([filename]) => String(filename) === captured.moduleUrl.href,
        );
        const constructed = constructions.mock.results[targetIndex];
        if (constructed?.type !== "return") {
          throw new Error("Original staging target handle was not observed");
        }
        const native = constructed.value;
        let nativeJoined = false;
        native.once("exit", () => {
          nativeJoined = true;
        });
        const location = path.join(directory, "database.sqlite");
        const originalBytes = createDatabase(
          location,
          "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('preserved');",
        );
        const releaseCurrentReader = currentCleanup.retainSnapshotTempDirectory(directory);
        const releaseOriginalReader = targetLost
          ? oldCleanup.retainSnapshotTempDirectory(directory)
          : undefined;
        let originalRemoved = false;
        let currentReleased = false;
        let bodyFailure: { error: unknown } | undefined;
        try {
          if (targetLost) {
            await expect(native.stop().result).rejects.toThrow("cleanup has not been requested");
            expect(native.executionStopped).toBe(true);
            expect(nativeJoined).toBe(false);
          }
          const failures: unknown[] = [];
          expect(
            await currentCleanup.removeTempDirectoryAsync(directory, (error) =>
              failures.push(error),
            ),
          ).toBe(false);
          expect(failures).toHaveLength(1);
          expect(failures[0]).toBeInstanceOf(currentCleanup.SqliteSnapshotCleanupError);
          expect(failures[0]).toMatchObject({
            message: "SQLite snapshot still belongs to an active reader",
          });
          expect(fs.readFileSync(location)).toEqual(originalBytes);
          releaseCurrentReader();

          if (targetLost) {
            failures.length = 0;
            expect(
              await currentCleanup.removeTempDirectoryAsync(directory, (error) =>
                failures.push(error),
              ),
            ).toBe(false);
            expect(failures).toHaveLength(1);
            expect(failures[0]).toBeInstanceOf(currentCleanup.SqliteSnapshotCleanupError);
            expect(failures[0]).toMatchObject({
              message: "SQLite snapshot still belongs to an active reader",
            });
            expect(nativeJoined).toBe(false);
            expect(fs.readFileSync(location)).toEqual(originalBytes);
            releaseOriginalReader?.();
            expect(await currentCleanup.removeTempDirectoryAsync(directory)).toBe(true);
            currentReleased = true;
            expect(nativeJoined).toBe(true);
            expect(fs.existsSync(directory)).toBe(false);
            expect(await oldCleanup.removeTempDirectoryAsync(directory)).toBe(true);
            originalRemoved = true;
          } else {
            // Only the original registry retires native custody before replacement bytes appear.
            expect(await oldCleanup.removeTempDirectoryAsync(directory)).toBe(true);
            originalRemoved = true;
            expect(nativeJoined).toBe(true);
            expect(fs.existsSync(directory)).toBe(false);
            fs.mkdirSync(directory);
            fs.writeFileSync(location, "replacement snapshot");
            expect(await currentCleanup.removeTempDirectoryAsync(directory)).toBe(true);
            currentReleased = true;
            expect(fs.readFileSync(location, "utf8")).toBe("replacement snapshot");
          }
        } catch (error) {
          bodyFailure = { error };
        }
        releaseCurrentReader();
        releaseOriginalReader?.();
        const cleanupFailures: unknown[] = [];
        for (const [label, released, cleanup] of [
          ["original", originalRemoved, oldCleanup],
          ["current", currentReleased, currentCleanup],
        ] as const) {
          if (released) {
            continue;
          }
          const failures: unknown[] = [];
          try {
            const removed = await cleanup.removeTempDirectoryAsync(directory, (error) =>
              failures.push(error),
            );
            if (!removed && failures.length === 0) {
              failures.push(
                new Error(`${label} snapshot cleanup returned false without a failure`),
              );
            }
          } catch (error) {
            failures.push(error);
          }
          cleanupFailures.push(...failures);
        }
        if (bodyFailure || cleanupFailures.length > 0) {
          throw new AggregateError(
            bodyFailure ? [bodyFailure.error, ...cleanupFailures] : cleanupFailures,
            "Snapshot regression or cleanup failed",
            { cause: bodyFailure ? bodyFailure.error : cleanupFailures[0] },
          );
        }
      } finally {
        constructions.mockRestore();
      }
    },
    async () => {
      generationReleased = true;
    },
  );
  expect(generationReleased).toBe(true);
});

it("retains a snapshot source's cleanup owner across module reload", async () => {
  const { captureSqliteSnapshotStagingOwner } = await import("./sqlite-snapshot-staging-owner.js");
  const source = path.join(root, "reload-source.sqlite");
  const original = createDatabase(
    source,
    "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('preserved');",
  );
  vi.stubEnv("XDG_CACHE_HOME", root);
  const options = { preserveSourceArtifacts: true, signal: new AbortController().signal };
  const first = startSqliteReadOnlyLocationAsync(source, options);
  try {
    expect(await (await first.result).cleanupAsync()).toBe(true);
  } finally {
    await first.startClose().result;
  }
  const originalOwner = captureSqliteSnapshotStagingOwner();
  vi.resetModules();
  const currentSource = await import("./sqlite-snapshot-source.js");
  const currentCleanup = await import("./sqlite-readonly-location-cleanup.js");
  const request = currentSource.startSqliteReadOnlyLocationAsync(source, options);
  const prepared = await request.result;
  const directory = prepared.cleanupRoot;
  if (!directory) {
    throw new Error("Expected the retained snapshot's cleanup root");
  }
  const releaseReader = currentCleanup.retainSnapshotTempDirectory(directory);
  try {
    const failures: unknown[] = [];
    expect(
      await currentCleanup.removeTempDirectoryAsync(directory, (error) => failures.push(error)),
    ).toBe(false);
    expect(failures).toEqual([
      expect.objectContaining({ message: "SQLite snapshot still belongs to an active reader" }),
    ]);
    expect(fs.existsSync(prepared.location)).toBe(true);
    await expect(originalOwner.retainDirectory(directory).startRetire().result).rejects.toThrow(
      "SQLite snapshot still belongs to an active reader",
    );
    expect(fs.existsSync(prepared.location)).toBe(true);
    releaseReader();
    expect(await prepared.cleanupAsync()).toBe(true);
    expect(fs.existsSync(directory)).toBe(false);
    expect(fs.readFileSync(source)).toEqual(original);
  } finally {
    releaseReader();
    if (fs.existsSync(directory)) {
      await originalOwner.retainDirectory(directory).startRetire().result;
    }
    expect(await currentCleanup.removeTempDirectoryAsync(directory)).toBe(true);
    expect(await prepared.cleanupAsync()).toBe(true);
    await request.startClose().result;
  }
});

it("joins reloaded snapshot consumers before original signal cleanup", async () => {
  const originalCleanup = await import("./sqlite-readonly-location-cleanup.js");
  vi.resetModules();
  const currentCleanup = await import("./sqlite-readonly-location-cleanup.js");
  const directory = path.join(root, "consumer-snapshot");
  const location = path.join(directory, "database.sqlite");
  fs.mkdirSync(directory);
  fs.writeFileSync(location, "snapshot bytes");
  const prepared = currentCleanup.adoptPreparedLocation(location, directory);
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  const consumer = currentCleanup.withPreparedSqliteSnapshot(prepared, async (snapshot) => {
    entered.resolve();
    await finish.promise;
    expect(fs.readFileSync(snapshot, "utf8")).toBe("snapshot bytes");
    return "read complete";
  });
  const stop = vi.fn();
  void currentCleanup.retainSnapshotWork(consumer, stop);
  await entered.promise;
  const cleanup = originalCleanup.cleanupSnapshotOperations();
  try {
    expect(stop).toHaveBeenCalledOnce();
    expect(fs.readFileSync(location, "utf8")).toBe("snapshot bytes");
    finish.resolve();
    expect(await consumer).toBe("read complete");
    await cleanup;
    expect(fs.existsSync(directory)).toBe(false);
  } finally {
    finish.resolve();
    await Promise.allSettled([consumer, cleanup]);
  }
});

it("retires the current snapshot during shared cleanup despite stale caller custody", async () => {
  const originalCleanup = await import("./sqlite-readonly-location-cleanup.js");
  const directory = path.join(root, "reused-snapshot");
  const location = path.join(directory, "database.sqlite");
  fs.mkdirSync(directory);
  const original = originalCleanup.adoptPreparedLocation(location, directory);
  vi.resetModules();
  const currentCleanup = await import("./sqlite-readonly-location-cleanup.js");
  currentCleanup.retainSnapshotTempDirectory(directory)();
  expect(await original.cleanupAsync()).toBe(true);
  fs.mkdirSync(directory);
  fs.writeFileSync(location, "replacement snapshot");
  const replacement = originalCleanup.adoptPreparedLocation(location, directory);
  try {
    await currentCleanup.cleanupSnapshotOperations();
    expect(fs.existsSync(directory)).toBe(false);
    expect(await currentCleanup.removeTempDirectoryAsync(directory)).toBe(true);
  } finally {
    expect(await replacement.cleanupAsync()).toBe(true);
  }
});

it("keeps synchronous and asynchronous token cleanup in separate snapshot flights", async () => {
  const source = path.join(root, "mixed-source.sqlite");
  const original = createDatabase(
    source,
    "CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('preserved');",
  );
  vi.stubEnv("XDG_CACHE_HOME", root);
  const synchronous = prepareSqliteReadOnlyLocation(source, { preserveSourceArtifacts: true });
  const asynchronous = startSqliteReadOnlyLocationAsync(source, {
    preserveSourceArtifacts: true,
  });
  try {
    const [syncSnapshot, asyncSnapshot] = await Promise.all([synchronous, asynchronous.result]);
    expect(syncSnapshot.cleanupRoot).toBeDefined();
    expect(asyncSnapshot.cleanupRoot).toBeDefined();
    expect(syncSnapshot.cleanupRoot).not.toBe(asyncSnapshot.cleanupRoot);
    for (const snapshot of [syncSnapshot, asyncSnapshot]) {
      const reader = new (requireNodeSqlite().DatabaseSync)(snapshot.location, { readOnly: true });
      try {
        expect(reader.prepare("SELECT value FROM probe").get()).toEqual({ value: "preserved" });
      } finally {
        reader.close();
      }
    }
    expect(syncSnapshot.cleanup()).toBe(true);
    expect(fs.existsSync(syncSnapshot.location)).toBe(false);
    expect(fs.existsSync(asyncSnapshot.location)).toBe(true);
    const failures: unknown[] = [];
    expect(removeTempDirectory(asyncSnapshot.cleanupRoot!, (error) => failures.push(error))).toBe(
      false,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(SqliteSnapshotCleanupError);
    expect(fs.existsSync(asyncSnapshot.location)).toBe(true);
    expect(await asyncSnapshot.cleanupAsync()).toBe(true);
    expect(fs.existsSync(asyncSnapshot.cleanupRoot!)).toBe(false);
    expect(fs.readFileSync(source)).toEqual(original);
  } finally {
    try {
      for (const result of await Promise.allSettled([synchronous, asynchronous.result])) {
        if (result.status === "fulfilled") {
          expect(await result.value.cleanupAsync()).toBe(true);
        }
      }
    } finally {
      await asynchronous.startClose().result;
    }
  }
});

// chmod-based denial only works on POSIX where the process is not root
// (root bypasses mode bits, and Windows chmod does not revoke deletion ACLs).
const supportsChmodDenial =
  process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

let root: string;

beforeEach(async () => {
  root = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), "snapshot-cleanup-owner-")),
  );
  await fs.promises.writeFile(path.join(root, "cleanup.log"), "");
  setLoggerOverride({ level: "warn", file: path.join(root, "cleanup.log") });
});

afterEach(async () => {
  await testApi.flushFileLogQueueForTests();
  setLoggerOverride(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Restore permissions so the fixture can be removed even when a test revoked
  // write access on a parent to trigger a real cleanup failure.
  await fs.promises.chmod(root, 0o700).catch(() => undefined);
  await fs.promises.rm(root, { recursive: true, force: true });
});

async function readCleanupLog(): Promise<unknown[]> {
  await testApi.flushFileLogQueueForTests();
  return (await fs.promises.readFile(path.join(root, "cleanup.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
}

// Revoke write access on the parent so fs.rmSync cannot unlink the owned root.
// This is a real filesystem failure at the cleanup boundary, not a mocked rm.
async function revokeParentWrite(): Promise<void> {
  await fs.promises.chmod(root, 0o500);
}

describe.runIf(supportsChmodDenial)("chmod-denied cleanup failure", () => {
  it("emits a non-throwing warning when cleanup cannot remove the owned directory", async () => {
    const { ownedRoot, location } = createSnapshot("owned");

    const reports: CleanupFailureReport[] = [];
    const prepared = adoptPreparedLocation(location, ownedRoot, false, (report) =>
      reports.push(report),
    );

    await revokeParentWrite();
    try {
      expect(prepared.cleanup()).toBe(false);
    } finally {
      await fs.promises.chmod(root, 0o700);
    }

    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({ cleanupRoot: ownedRoot, operation: "rm", code: "EACCES" });
    // The owned copy remains on disk; the exit handler retries removal later.
    expect(fs.existsSync(ownedRoot)).toBe(true);
    // A successful read's outcome is preserved: cleanup did not throw, and repeated
    // attempts never duplicate the diagnostic — the owner records the failure once.
    prepared.cleanup();
    expect(reports).toHaveLength(1);
  });
});

it.each(["idle", "pending"] as const)(
  "preserves replacement bytes when stale async cleanup is %s",
  async (asyncState) => {
    const { ownedRoot, location } = createSnapshot("healthy");

    const reports: CleanupFailureReport[] = [];
    const prepared = adoptPreparedLocation(location, ownedRoot, false, (report) =>
      reports.push(report),
    );

    const staleSync = adoptPreparedLocation(location, ownedRoot);
    const staleAsync = adoptPreparedLocation(location, ownedRoot);
    const asyncCleanup = asyncState === "pending" ? staleAsync.cleanupAsync() : undefined;

    expect(prepared.cleanup()).toBe(true);
    expect(reports).toHaveLength(0);
    expect(fs.existsSync(ownedRoot)).toBe(false);
    // A second cleanup is a no-op once the owner has removed its directory.
    expect(prepared.cleanup()).toBe(true);
    expect(reports).toHaveLength(0);

    fs.mkdirSync(ownedRoot);
    fs.writeFileSync(location, "replacement snapshot");
    const replacement = adoptPreparedLocation(location, ownedRoot);
    try {
      expect(staleSync.cleanup()).toBe(true);
      expect(await (asyncCleanup ?? staleAsync.cleanupAsync())).toBe(true);
      expect(fs.readFileSync(location, "utf8")).toBe("replacement snapshot");
    } finally {
      expect(await replacement.cleanupAsync()).toBe(true);
    }
  },
);

it("records cleanup diagnostics in the structured log without process or console warnings", async () => {
  const processWarning = vi.spyOn(process, "emitWarning");
  const consoleWarning = vi.spyOn(console, "warn");
  const { ownedRoot, location } = createSnapshot("diagnostic-only");
  vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
    throw Object.assign(new Error("snapshot busy"), { code: "EBUSY" });
  });
  const prepared = adoptPreparedLocation(location);
  expect(prepared.cleanupRoot).toBe(ownedRoot);
  expect(prepared.cleanup()).toBe(false);
  const records = await readCleanupLog();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    "1": { path: ownedRoot, operation: "rm", errorCode: "EBUSY" },
    message: expect.stringContaining("SQLite read-only snapshot cleanup failed"),
  });
  expect(processWarning).not.toHaveBeenCalled();
  expect(consoleWarning).not.toHaveBeenCalled();
});

describe.runIf(supportsChmodDenial)("chmod-denied requireCleanup", () => {
  it("still throws on cleanup failure when requireCleanup is set", async () => {
    const { ownedRoot, location } = createSnapshot("required");

    const prepared = adoptPreparedLocation(location, ownedRoot, true);

    await revokeParentWrite();
    try {
      expect(() => prepared.cleanup()).toThrow(/snapshot cleanup failed/u);
    } finally {
      await fs.promises.chmod(root, 0o700);
    }
  });
});

it("does not throw when the onCleanupFailure callback itself throws", async () => {
  const { ownedRoot, location } = createSnapshot("throwing-callback");

  // Force removal failure via fs.rmSync mock so the callback is exercised on
  // every platform, including root POSIX and Windows (where chmod can't deny).
  vi.spyOn(fs, "rmSync").mockImplementation(() => {
    throw Object.assign(new Error("mock removal failure"), { code: "EBUSY" });
  });

  const prepared = adoptPreparedLocation(location, ownedRoot, false, () => {
    throw new Error("callback exploded");
  });

  try {
    // cleanup() must not throw even though the callback throws — the
    // non-throwing contract (requireCleanup=false) must hold.
    expect(prepared.cleanup()).toBe(false);
  } finally {
    vi.restoreAllMocks();
  }

  const records = await readCleanupLog();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    "1": { path: ownedRoot, operation: "rm", errorCode: "EBUSY" },
  });
  expect(JSON.stringify(records)).not.toContain("callback exploded");
});
