import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
let root: string;
let env: NodeJS.ProcessEnv;
let source: string;
let prepared: ReturnType<typeof adoptPreparedLocation>;
let releaseReader: (() => void) | undefined;
beforeEach(() => {
  root = fs.realpathSync(dirs.make("update-schema-cleanup-"));
  const handoff = path.join(root, "handoff");
  fs.mkdirSync(handoff);
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(handoff);
  const databasePath = resolveManagedUpdateLeaseDatabasePath();
  expect(databasePath).toBe(path.join(handoff, "managed-update-handoffs.sqlite"));
  expect(path.join(fs.realpathSync(path.dirname(databasePath)), path.basename(databasePath))).toBe(
    databasePath,
  );
  expect(databasePath).not.toMatch(/^\/(?:private\/)?tmp\/openclaw(?:\/|$)/u);
  env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
  source = resolveOpenClawStateSqlitePath(env);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  expect(path.join(fs.realpathSync(path.dirname(source)), path.basename(source))).toBe(source);
  expect(source.startsWith(`${root}${path.sep}`)).toBe(true);
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(source);
  database.exec("PRAGMA user_version = 1;");
  database.close();
  const snapshot = path.join(root, "snapshot");
  fs.mkdirSync(snapshot);
  const location = path.join(snapshot, "state.sqlite");
  fs.copyFileSync(source, location);
  prepared = adoptPreparedLocation(location, snapshot, false, () => {});
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

it("refuses actual forward update admission when a real snapshot reader prevents cleanup", async () => {
  const before = fs.readFileSync(source);
  releaseReader = retainSnapshotTempDirectory(path.dirname(prepared.location));
  await expect(runUpdate()).rejects.toThrow(/snapshot cleanup failed/i);
  expect(fs.existsSync(prepared.location)).toBe(true);
  expect(await prepared.cleanupAsync()).toBe(false);
  expect(fs.readFileSync(source)).toEqual(before);
  expect(snapshots.prepareSqliteReadOnlyLocation).toHaveBeenCalledTimes(1);
});

it("refuses failed owned scratch removal and admits a retry after removal recovers", async () => {
  const original = fs.readFileSync(source);
  const remove = fs.promises.rm;
  const failure = Object.assign(new Error("owned scratch removal denied"), { code: "EACCES" });
  const removal = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
    if (target === prepared.cleanupRoot) {
      throw failure;
    }
    return remove(target, options);
  });
  try {
    await expect(runUpdate()).rejects.toThrow(/snapshot cleanup failed/i);
    expect(fs.existsSync(prepared.location)).toBe(true);
    expect(fs.readFileSync(source)).toEqual(original);
  } finally {
    removal.mockRestore();
  }
  await expect(runUpdate()).resolves.toMatchObject({
    packageSchemaPreflight: { incompatible: [], indeterminate: [] },
  });
  expect(fs.existsSync(prepared.location)).toBe(false);
  expect(fs.readFileSync(source)).toEqual(original);
});

it("propagates rejected cleanup unchanged through the forward update caller", async () => {
  const failure = new Error("snapshot owner could not retire");
  vi.spyOn(prepared, "cleanupAsync").mockRejectedValue(failure);
  await expect(runUpdate()).rejects.toBe(failure);
});

it("admits normal forward update only after snapshot cleanup has settled", async () => {
  const unrelatedRoot = path.join(root, "unrelated-snapshot");
  fs.mkdirSync(unrelatedRoot);
  const unrelatedPath = path.join(unrelatedRoot, "state.sqlite");
  fs.copyFileSync(source, unrelatedPath);
  const unrelated = adoptPreparedLocation(unrelatedPath, unrelatedRoot);
  const original = fs.readFileSync(source);
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
      expect(fs.readFileSync(unrelatedPath)).toEqual(original);
      expect(fs.readFileSync(source)).toEqual(original);
    } finally {
      expect(await unrelated.cleanupAsync()).toBe(true);
    }
  }
  await expect(update).resolves.toMatchObject({
    packageSchemaPreflight: { incompatible: [], indeterminate: [] },
  });
  expect(fs.existsSync(prepared.location)).toBe(false);
});

it.each(["false", "reject"] as const)(
  "preserves cancellation and %s cleanup failure without admitting remaining databases",
  async (mode) => {
    const controller = new AbortController();
    const cancellation = new Error("original update cancellation");
    const cleanupFailure = new Error("snapshot retirement rejected");
    const prepare = vi.mocked(snapshots.prepareSqliteReadOnlyLocation).getMockImplementation()!;
    vi.mocked(snapshots.prepareSqliteReadOnlyLocation).mockImplementation(async (...args) => {
      const location = await prepare(...args);
      controller.abort(cancellation);
      return location;
    });
    if (mode === "false") {
      releaseReader = retainSnapshotTempDirectory(path.dirname(prepared.location));
    } else {
      vi.spyOn(prepared, "cleanupAsync").mockRejectedValue(cleanupFailure);
    }
    const candidates = vi.fn(() => []);
    const failure = await preflightOpenClawDatabaseSchemas({
      env,
      supportedVersions: versions,
      signal: controller.signal,
      configuredAgentDatabaseTargets: candidates,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).cause).toBe(cancellation);
    expect((failure as AggregateError).errors[0]).toBe(cancellation);
    if (mode === "reject") {
      expect((failure as AggregateError).errors[1]).toBe(cleanupFailure);
    } else {
      expect((failure as AggregateError).errors[1]).toMatchObject({
        message: expect.stringMatching(/snapshot cleanup failed/i),
      });
    }
    expect(candidates).not.toHaveBeenCalled();
    expect(fs.existsSync(prepared.location)).toBe(true);
  },
);

it("preserves exact cancellation when cleanup succeeds", async () => {
  const controller = new AbortController();
  const cancellation = new Error("original cancellation");
  vi.mocked(snapshots.prepareSqliteReadOnlyLocation).mockImplementation(async () => {
    controller.abort(cancellation);
    return prepared;
  });
  await expect(
    preflightOpenClawDatabaseSchemas({
      env,
      supportedVersions: versions,
      signal: controller.signal,
    }),
  ).rejects.toBe(cancellation);
  expect(fs.existsSync(prepared.location)).toBe(false);
});

it.each(["false", "reject"] as const)(
  "preserves the earlier inspection error when snapshot cleanup returns %s",
  async (mode) => {
    const primary = new Error("original schema-read admission failure");
    const secondary = new Error("retirement rejected");
    if (mode === "false") {
      releaseReader = retainSnapshotTempDirectory(path.dirname(prepared.location));
    } else {
      vi.spyOn(prepared, "cleanupAsync").mockRejectedValue(secondary);
    }
    const failure = await preflightOpenClawDatabaseSchemas({
      env,
      supportedVersions: versions,
      openStateSchemaReadAdmission: () => {
        throw primary;
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).cause).toBe(primary);
    expect((failure as AggregateError).errors[0]).toBe(primary);
    expect((failure as AggregateError).errors).toHaveLength(2);
    if (mode === "reject") {
      expect((failure as AggregateError).errors[1]).toBe(secondary);
    } else {
      expect((failure as AggregateError).errors[1]).toMatchObject({
        message: expect.stringMatching(/snapshot cleanup failed/i),
      });
    }
  },
);

it("retains both a read-admission close failure and snapshot retirement failure", async () => {
  const primary = new Error("admission close failed");
  const secondary = new Error("snapshot cleanup rejected");
  let inspectedDatabase: import("node:sqlite").DatabaseSync | undefined;
  vi.spyOn(prepared, "cleanupAsync").mockRejectedValue(secondary);
  const failure = await preflightOpenClawDatabaseSchemas({
    env,
    supportedVersions: versions,
    scope: "state",
    openStateSchemaReadAdmission: (database) => {
      inspectedDatabase = database;
      return () => {
        throw primary;
      };
    },
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).cause).toBe(primary);
  expect((failure as AggregateError).errors).toEqual([primary, secondary]);
  expect(inspectedDatabase?.isOpen).toBe(false);
});
