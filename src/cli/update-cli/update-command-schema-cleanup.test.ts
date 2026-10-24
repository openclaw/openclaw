import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  adoptPreparedLocation,
  retainSnapshotTempDirectory,
} from "../../infra/sqlite-readonly-location-cleanup.js";
import * as snapshots from "../../infra/sqlite-snapshot-source.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../../infra/update-managed-service-handoff-lease.js";
import { preflightOpenClawDatabaseSchemas } from "../../state/openclaw-database-preflight.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import { preflightUpdateCommandSchemas } from "./update-command-schema.js";

vi.mock("./update-command-database-context.js", () => ({
  inspectUpdateDatabaseContexts: vi.fn(),
}));
vi.mock("./update-command-git.js", () => ({
  inspectGitDryRunTargetSchemaVersions: vi.fn(),
}));

const dirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    releaseReader?.();
    releaseReader = undefined;
    vi.restoreAllMocks();
    expect(await prepared.cleanupAsync()).toBe(true);
    cleanup();
  });
});
const versions = { state: 1, agent: 1 };
const admittedSchemas = { packageSchemaPreflight: { incompatible: [], indeterminate: [] } };
let root: string;
let env: NodeJS.ProcessEnv;
let source: string;
let original: Buffer;
let prepared: ReturnType<typeof adoptPreparedLocation>;
let releaseReader: (() => void) | undefined;
beforeEach(() => {
  root = fs.realpathSync(dirs.make("update-schema-cleanup-"));
  const handoff = path.join(root, "handoff");
  fs.mkdirSync(handoff);
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(handoff);
  const databasePath = resolveManagedUpdateLeaseDatabasePath();
  expect(databasePath).toBe(path.join(handoff, "managed-update-handoffs.sqlite"));
  env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
  source = resolveOpenClawStateSqlitePath(env);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  expect(source.startsWith(`${root}${path.sep}`)).toBe(true);
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(source);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA user_version = 1;");
  database.close();
  original = fs.readFileSync(source);
  // An incomplete WAL family takes ordinary admission through private recovery.
  expect(fs.existsSync(`${source}-wal`)).toBe(false);
  expect(fs.existsSync(`${source}-shm`)).toBe(false);
  prepared = makeSnapshot("snapshot", () => {});
  vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(async (pathname) => {
    expect(pathname).toBe(fs.realpathSync(source));
    expect(resolveManagedUpdateLeaseDatabasePath()).toBe(databasePath);
    return prepared;
  });
  vi.mocked(inspectUpdateDatabaseContexts).mockResolvedValue({
    contexts: [{ config: {}, env }],
    services: new Map(),
    foreground: true,
  } as Awaited<ReturnType<typeof inspectUpdateDatabaseContexts>>);
});

function makeSnapshot(name: string, onFailure?: Parameters<typeof adoptPreparedLocation>[3]) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  const location = path.join(directory, "state.sqlite");
  fs.copyFileSync(source, location);
  return adoptPreparedLocation(location, directory, false, onFailure);
}

function runUpdate() {
  return preflightUpdateCommandSchemas({
    root,
    updateInstallKind: "package",
    switchToGit: false,
    shouldRestart: false,
    updateStepTimeoutMs: 1_000,
    managedServiceRootRedirect: null,
    channel: "stable",
    packageTargetSchemaVersions: versions,
    packageAlreadyCurrent: false,
    opts: {},
    refuseUpdate: vi.fn(),
  });
}

function expectPrimaryFailure(failure: unknown, primary: Error) {
  assert.instanceOf(failure, AggregateError);
  expect(failure.cause).toBe(primary);
  expect(failure.errors[0]).toBe(primary);
  return failure;
}

it.each(["DELETE", "WAL"])(
  "admits online update without acquiring an unrelated snapshot (%s)",
  async (journalMode) => {
    using database = new (requireNodeSqlite().DatabaseSync)(source);
    database.exec(`PRAGMA journal_mode = ${journalMode}; CREATE TABLE online_probe(value);`);
    if (journalMode === "WAL") {
      expect(fs.statSync(`${source}-wal`).size).toBeGreaterThan(32);
      expect(fs.existsSync(`${source}-shm`)).toBe(true);
    }
    await expect(runUpdate()).resolves.toMatchObject(admittedSchemas);
    expect(snapshots.prepareSqliteReadOnlyLocation).not.toHaveBeenCalled();
    expect(fs.existsSync(prepared.location)).toBe(true);
  },
);

it.each(["reader", "removal", "rejection"] as const)(
  "refuses forward update admission after snapshot cleanup failure: %s",
  async (failureKind) => {
    if (failureKind === "rejection") {
      const failure = new Error("snapshot owner could not retire");
      vi.spyOn(prepared, "cleanupAsync").mockRejectedValue(failure);
      await expect(runUpdate()).rejects.toBe(failure);
      return;
    }
    const remove = fs.promises.rm;
    const failure = Object.assign(new Error("owned scratch removal denied"), { code: "EACCES" });
    if (failureKind === "reader") {
      releaseReader = retainSnapshotTempDirectory(path.dirname(prepared.location));
    }
    const removal =
      failureKind === "removal"
        ? vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
            if (target === prepared.cleanupRoot) {
              throw failure;
            }
            return remove(target, options);
          })
        : undefined;
    await expect(runUpdate()).rejects.toThrow(/snapshot cleanup failed/i);
    expect(fs.existsSync(prepared.location)).toBe(true);
    expect(fs.readFileSync(source)).toEqual(original);
    if (failureKind === "reader") {
      expect(await prepared.cleanupAsync()).toBe(false);
      expect(snapshots.prepareSqliteReadOnlyLocation).toHaveBeenCalledTimes(1);
      return;
    }
    removal?.mockRestore();
    await expect(runUpdate()).resolves.toMatchObject(admittedSchemas);
    expect(fs.existsSync(prepared.location)).toBe(false);
    expect(fs.readFileSync(source)).toEqual(original);
  },
);

it("admits normal forward update only after snapshot cleanup has settled", async () => {
  const unrelated = makeSnapshot("unrelated-snapshot");
  const release = createDeferred();
  const started = createDeferred();
  const cleanup = prepared.cleanupAsync;
  vi.spyOn(prepared, "cleanupAsync").mockImplementation(async () => {
    started.resolve();
    await release.promise;
    return cleanup();
  });
  let settled = false;
  const update = runUpdate().finally(() => {
    settled = true;
  });
  try {
    await Promise.race([started.promise, update]);
    expect(settled).toBe(false);
    expect(fs.existsSync(prepared.location)).toBe(true);
  } finally {
    release.resolve();
    await Promise.allSettled([update]);
    try {
      expect(fs.readFileSync(unrelated.location)).toEqual(original);
      expect(fs.readFileSync(source)).toEqual(original);
    } finally {
      expect(await unrelated.cleanupAsync()).toBe(true);
    }
  }
  await expect(update).resolves.toMatchObject(admittedSchemas);
  expect(fs.existsSync(prepared.location)).toBe(false);
});

it.each([false, true])(
  "preserves cancellation without admitting more databases (reader=%s)",
  async (retained) => {
    const controller = new AbortController();
    const cancellation = new Error("original update cancellation");
    const prepare = vi.mocked(snapshots.prepareSqliteReadOnlyLocation).getMockImplementation()!;
    vi.mocked(snapshots.prepareSqliteReadOnlyLocation).mockImplementation(async (...args) => {
      const location = await prepare(...args);
      controller.abort(cancellation);
      return location;
    });
    if (retained) {
      releaseReader = retainSnapshotTempDirectory(path.dirname(prepared.location));
    }
    const candidates = vi.fn(() => []);
    const inspection = preflightOpenClawDatabaseSchemas({
      env,
      supportedVersions: versions,
      signal: controller.signal,
      configuredAgentDatabaseTargets: candidates,
    });
    const failure = await inspection.catch((error: unknown) => error);
    if (retained) {
      expect(expectPrimaryFailure(failure, cancellation).errors[1]).toMatchObject({
        message: expect.stringMatching(/snapshot cleanup failed/i),
      });
    } else {
      expect(failure).toBe(cancellation);
    }
    expect(candidates).not.toHaveBeenCalled();
    expect(fs.existsSync(prepared.location)).toBe(retained);
  },
);

it.each(["inspection", "close"] as const)(
  "preserves %s failure ahead of snapshot retirement failure",
  async (phase) => {
    const primary = new Error(`admission ${phase} failed`);
    const secondary = new Error("snapshot cleanup rejected");
    let inspectedDatabase: import("node:sqlite").DatabaseSync | undefined;
    vi.spyOn(prepared, "cleanupAsync").mockRejectedValue(secondary);
    const failure = await preflightOpenClawDatabaseSchemas({
      env,
      supportedVersions: versions,
      scope: phase === "close" ? "state" : undefined,
      openStateSchemaReadAdmission: (database) => {
        if (phase === "inspection") {
          throw primary;
        }
        inspectedDatabase = database;
        return () => {
          throw primary;
        };
      },
    }).catch((error: unknown) => error);
    const aggregate = expectPrimaryFailure(failure, primary);
    expect(aggregate.errors).toEqual([primary, secondary]);
    expect(aggregate.errors[1]).toBe(secondary);
    if (phase === "close") {
      expect(inspectedDatabase?.isOpen).toBe(false);
    }
  },
);
