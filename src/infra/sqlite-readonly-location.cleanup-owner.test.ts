import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLoggerOverride } from "../logging/logger.js";
import { testApi } from "../logging/logger.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  adoptPreparedLocation,
  registerAsyncSnapshotTempDirectory,
  retainSnapshotTempDirectory,
  type CleanupFailureReport,
} from "./sqlite-readonly-location-cleanup.js";
import type { SqliteReadOnlyWorkerOptions } from "./sqlite-readonly-worker-protocol.js";
import * as worker from "./sqlite-readonly-worker.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationAsync,
} from "./sqlite-snapshot-source.js";
import * as staging from "./sqlite-snapshot-staging.js";

function mockSnapshotCopy(copy: (options: SqliteReadOnlyWorkerOptions) => Promise<string>) {
  function run(
    pathname: string,
    options: { mode: "reclaim"; signal?: AbortSignal },
  ): Promise<string[]>;
  function run(pathname: string, options: SqliteReadOnlyWorkerOptions): Promise<string>;
  function run(
    _pathname: string,
    options: SqliteReadOnlyWorkerOptions,
  ): Promise<string | string[]> {
    if (options.mode !== "sync" && options.mode !== "async") {
      throw new Error(`Unexpected snapshot fixture mode: ${options.mode}`);
    }
    return copy(options);
  }
  return vi.spyOn(worker, "runSqliteReadOnlyWorker").mockImplementation(run);
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

it("retains async token custody through failed retirement before retrying removal", async () => {
  const directory = path.join(root, "async-retirement");
  await fs.promises.mkdir(directory);
  const location = path.join(directory, "database.sqlite");
  await fs.promises.writeFile(location, "retained snapshot");
  let attempts = 0;
  registerAsyncSnapshotTempDirectory(directory, async () => {
    attempts++;
    if (attempts === 1) {
      throw new Error("retirement was not acknowledged");
    }
  });
  const prepared = adoptPreparedLocation(location, directory);
  expect(await prepared.cleanupAsync()).toBe(false);
  expect(fs.readFileSync(location, "utf8")).toBe("retained snapshot");
  expect(() => retainSnapshotTempDirectory(directory)).toThrow("retirement has started");
  expect(await prepared.cleanupAsync()).toBe(true);
  expect(attempts).toBe(2);
  expect(fs.existsSync(directory)).toBe(false);
});

it("keeps synchronous and asynchronous token cleanup in separate snapshot flights", async () => {
  const started = createDeferredCore();
  const proceed = createDeferredCore();
  const allocations: boolean[] = [];
  vi.spyOn(staging, "createSqliteSnapshotStagingDirectory").mockImplementation(
    async (_directory, _legacy, _signal, asynchronousCleanup = false) => {
      allocations.push(asynchronousCleanup);
      const directory = path.join(root, asynchronousCleanup ? "async-token" : "sync-token");
      await fs.promises.mkdir(directory);
      return directory;
    },
  );
  mockSnapshotCopy(async (options) => {
    if (!options.stagingRoot) {
      throw new Error("Expected an owned snapshot root");
    }
    started.resolve();
    await proceed.promise;
    return path.join(options.stagingRoot, "database.sqlite");
  });
  const source = path.join(root, "mixed-source.sqlite");
  const synchronous = prepareSqliteReadOnlyLocation(source, { preserveSourceArtifacts: true });
  await started.promise;
  const asynchronous = prepareSqliteReadOnlyLocationAsync(source, {
    preserveSourceArtifacts: true,
  });
  proceed.resolve();
  const [syncSnapshot, asyncSnapshot] = await Promise.all([synchronous, asynchronous]);
  try {
    expect(syncSnapshot.cleanupRoot).toBe(path.join(root, "sync-token"));
    expect(asyncSnapshot.cleanupRoot).toBe(path.join(root, "async-token"));
    expect(allocations).toEqual([false, true]);
  } finally {
    await syncSnapshot.cleanupAsync();
    await asyncSnapshot.cleanupAsync();
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
    const ownedRoot = path.join(root, "owned");
    const location = path.join(ownedRoot, "database.sqlite");
    await fs.promises.mkdir(ownedRoot, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(location, "snapshot bytes");

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

it("does not emit a warning when cleanup succeeds", async () => {
  const ownedRoot = path.join(root, "healthy");
  const location = path.join(ownedRoot, "database.sqlite");
  await fs.promises.mkdir(ownedRoot, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(location, "snapshot bytes");

  const reports: CleanupFailureReport[] = [];
  const prepared = adoptPreparedLocation(location, ownedRoot, false, (report) =>
    reports.push(report),
  );

  expect(prepared.cleanup()).toBe(true);
  expect(reports).toHaveLength(0);
  expect(fs.existsSync(ownedRoot)).toBe(false);
  // A second cleanup is a no-op once the owner has removed its directory.
  expect(prepared.cleanup()).toBe(true);
  expect(reports).toHaveLength(0);
});

describe.runIf(supportsChmodDenial)("chmod-denied default sink", () => {
  it("uses the structured log as the default sink when no callback is supplied", async () => {
    const ownedRoot = path.join(root, "default-sink");
    const location = path.join(ownedRoot, "database.sqlite");
    await fs.promises.mkdir(ownedRoot, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(location, "snapshot bytes");

    const processWarning = vi.spyOn(process, "emitWarning");
    const consoleWarning = vi.spyOn(console, "warn");

    const prepared = adoptPreparedLocation(location, ownedRoot, false);

    await revokeParentWrite();
    try {
      expect(prepared.cleanup()).toBe(false);
    } finally {
      await fs.promises.chmod(root, 0o700);
    }

    const records = await readCleanupLog();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      "1": { path: ownedRoot, operation: "rm", errorCode: "EACCES" },
      message: expect.stringContaining("SQLite read-only snapshot cleanup failed"),
    });
    expect(processWarning).not.toHaveBeenCalled();
    expect(consoleWarning).not.toHaveBeenCalled();
  });
});

it("records structured cleanup diagnostics", async () => {
  const ownedRoot = path.join(root, "diagnostic-only");
  await fs.promises.mkdir(ownedRoot);
  vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
    throw Object.assign(new Error("snapshot busy"), { code: "EBUSY" });
  });
  const prepared = adoptPreparedLocation(path.join(ownedRoot, "database.sqlite"), ownedRoot);
  expect(prepared.cleanup()).toBe(false);
  const records = await readCleanupLog();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    "1": { path: ownedRoot, operation: "rm", errorCode: "EBUSY" },
    message: expect.stringContaining("SQLite read-only snapshot cleanup failed"),
  });
});

describe.runIf(supportsChmodDenial)("chmod-denied requireCleanup", () => {
  it("still throws on cleanup failure when requireCleanup is set", async () => {
    const ownedRoot = path.join(root, "required");
    const location = path.join(ownedRoot, "database.sqlite");
    await fs.promises.mkdir(ownedRoot, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(location, "snapshot bytes");

    const prepared = adoptPreparedLocation(location, ownedRoot, true);

    await revokeParentWrite();
    try {
      expect(() => prepared.cleanup()).toThrow(/snapshot cleanup failed/u);
    } finally {
      await fs.promises.chmod(root, 0o700);
    }
  });
});

it("exposes cleanupRoot as the directory cleanup owns", () => {
  const ownedRoot = path.join(root, "explicit-root");
  const location = path.join(ownedRoot, "database.sqlite");
  const prepared = adoptPreparedLocation(location, ownedRoot);
  expect(prepared.cleanupRoot).toBe(ownedRoot);

  // Without an explicit owned root, cleanup owns the directory holding the snapshot.
  const fallback = adoptPreparedLocation(path.join(root, "fallback", "database.sqlite"));
  expect(fallback.cleanupRoot).toBe(path.join(root, "fallback"));
});

it("does not emit a false warning when synchronous cleanup races an in-flight async removal", async () => {
  const ownedRoot = path.join(root, "concurrent");
  const location = path.join(ownedRoot, "database.sqlite");
  await fs.promises.mkdir(ownedRoot, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(location, "snapshot bytes");

  const reports: CleanupFailureReport[] = [];
  const prepared = adoptPreparedLocation(location, ownedRoot, false, (report) =>
    reports.push(report),
  );

  // Start an async removal but do not await it yet.  The synchronous cleanup()
  // sees `pending` and must return false without reporting a failure — the
  // async path reports the actual outcome when it settles.
  const removal = prepared.cleanupAsync();
  // Let the microtask queue drain so the pending promise is set.
  await Promise.resolve();
  expect(prepared.cleanup()).toBe(false);
  expect(reports).toHaveLength(0);

  await removal;
  // The async removal succeeded, so no warning should ever have been emitted.
  expect(reports).toHaveLength(0);
  expect(fs.existsSync(ownedRoot)).toBe(false);
});

it("does not throw when the onCleanupFailure callback itself throws", async () => {
  const ownedRoot = path.join(root, "throwing-callback");
  const location = path.join(ownedRoot, "database.sqlite");
  await fs.promises.mkdir(ownedRoot, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(location, "snapshot bytes");

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

it("reports non-Error callback failures without throwing", async () => {
  const ownedRoot = path.join(root, "non-error-callback");
  const location = path.join(ownedRoot, "database.sqlite");
  await fs.promises.mkdir(ownedRoot, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(location, "snapshot bytes");

  const processWarning = vi.spyOn(process, "emitWarning");
  vi.spyOn(fs, "rmSync").mockImplementation(() => {
    throw Object.assign(new Error("mock removal failure"), { code: "EBUSY" });
  });

  const prepared = adoptPreparedLocation(location, ownedRoot, false, () => {
    // oxlint-disable-next-line typescript/only-throw-error -- Exercise non-Error failures at the cleanup boundary.
    throw 42;
  });

  try {
    expect(prepared.cleanup()).toBe(false);
  } finally {
    expect(processWarning).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  }

  const records = await readCleanupLog();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    "1": { path: ownedRoot, operation: "rm", errorCode: "EBUSY" },
  });
});
