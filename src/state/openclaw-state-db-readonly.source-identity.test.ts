import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readDeferredPluginMigrationsAsync } from "../infra/deferred-plugin-migrations.js";
import { defaultPayload } from "../infra/gateway-state-owner-record.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "../infra/sqlite-private-directory.js";
import { cleanupSnapshotOperations } from "../infra/sqlite-readonly-location-cleanup.js";
import { withSqliteSnapshotReuse } from "../infra/sqlite-snapshot-reuse.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { settle } from "./openclaw-state-db-fixtures.test-support.js";
import {
  executeExistingOpenClawStateRead as readExisting,
  withArtifactPreservingStateReads as preserveArtifacts,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly as readSync,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync as readAsync,
  withSynchronousArtifactPreservingStateSnapshot as syncScope,
  withOpenClawStateDatabaseReadSnapshot as frozenScope,
} from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync as closeState,
  closeOpenClawStateDatabaseForTest as resetState,
  openOpenClawStateDatabase as openState,
} from "./openclaw-state-db.js";
import { captureOpenClawStateReadWorkerContext as captureReadContext } from "./openclaw-state-worker-context.js";

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeState();
    await cleanupSnapshotOperations();
    resetState();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  });
});

function sourceFixture() {
  const root = directories.make("state-read-identity-");
  vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"));
  const options = {
    path: path.join(root, "state", "openclaw.sqlite"),
    env: { OPENCLAW_STATE_DIR: root, OPENCLAW_TEST_FAST: "1" },
  };
  const stateKey = "readonly.identity.fixture";
  const seed = (pathname: string, value: string) => {
    const { db } = openState({ ...options, path: pathname });
    db.prepare(
      "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
    ).run(stateKey, JSON.stringify({ source: value }), 1);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
  };
  const read = (context: ReturnType<typeof captureReadContext>) =>
    preserveArtifacts(() =>
      readExisting(options, { type: "tui.lastSession.read", stateKey }, { context }),
    );
  return { root, options, seed, read };
}

it("rejects successor bytes substituted after fresh validation and before snapshot preparation", async () => {
  const { root, options, seed, read } = sourceFixture();
  const replacement = path.join(root, "replacement.sqlite");
  const archived = path.join(root, "original.sqlite");
  seed(options.path, "original");
  seed(replacement, "successor");
  // The measured read must take fresh snapshot preparation, never the cached native branch.
  await closeState();
  const originalIdentity = readDatabasePathIdentitySync(options.path);
  const replacementIdentity = readDatabasePathIdentitySync(replacement);
  expect(replacementIdentity.key).not.toBe(originalIdentity.key);
  const originalBytes = fs.readFileSync(options.path);
  const replacementBytes = fs.readFileSync(replacement);
  const context = captureReadContext(options);
  expect(context.admission.identity.key).toBe(originalIdentity.key);

  const startPreparation = snapshots.startSqliteReadOnlyLocationAsync;
  vi.spyOn(snapshots, "startSqliteReadOnlyLocationAsync").mockImplementationOnce(
    (pathname, preparationOptions) => {
      // This real entry is reached only after the original fresh-validation operation settles.
      fs.renameSync(options.path, archived);
      fs.renameSync(replacement, options.path);
      return startPreparation(pathname, preparationOptions);
    },
  );
  const outcome = await settle(read(context));

  expect(readDatabasePathIdentitySync(options.path).key).toBe(replacementIdentity.key);
  assert("error" in outcome, "The original read admission accepted a replacement database");
  expect(
    collectNestedErrorCandidates(outcome.error).some(
      (error) => error instanceof Error && /identity|source.*changed/i.test(error.message),
    ),
  ).toBe(true);
  expect(fs.readFileSync(archived).equals(originalBytes), archived).toBe(true);
  expect(fs.readFileSync(options.path).equals(replacementBytes), options.path).toBe(true);
});

it.runIf(process.platform === "darwin" && fs.existsSync("/usr/bin/SetFile"))(
  "reads the admitted source after a same-inode birthtime metadata change",
  async () => {
    const { options, seed, read } = sourceFixture();
    const value = JSON.stringify({ source: "original" });
    seed(options.path, "original");
    await closeState();
    const context = captureReadContext(options);
    const before = fs.statSync(options.path, { bigint: true });
    const sourceBytes = fs.readFileSync(options.path);
    const sourceFiles = fs.readdirSync(path.dirname(options.path)).toSorted();
    expect(context.admission.identity.birthtime).toBe(before.birthtimeNs.toString());
    const stagingRoot = resolvePrivateSqliteSnapshotStagingRoot();
    const stagingBefore = fs.readdirSync(stagingRoot).toSorted();

    // Creation-time metadata can change without retiring the admitted physical file.
    execFileSync("/usr/bin/SetFile", ["-d", "01/02/2000 03:04:05", options.path]);
    const after = fs.statSync(options.path, { bigint: true });
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    expect(after.birthtimeNs).not.toBe(before.birthtimeNs);
    expect(() => context.admission.assertCurrent()).not.toThrow();
    expect(await read(context)).toMatchObject({
      ok: true,
      type: "tui.lastSession.read",
      row: { value_json: value, updated_at_ms: 1 },
    });
    await closeState();
    await cleanupSnapshotOperations();
    expect(fs.readdirSync(stagingRoot).toSorted()).toEqual(stagingBefore);
    expect(fs.readFileSync(options.path)).toEqual(sourceBytes);
    expect(fs.readdirSync(path.dirname(options.path)).toSorted()).toEqual(sourceFiles);
    const { dev, ino, birthtimeNs } = after;
    expect(fs.statSync(options.path, { bigint: true })).toMatchObject({ dev, ino, birthtimeNs });
  },
);

it("reads live-owned state directly while explicit snapshots retain private images", async () => {
  const { options, seed } = sourceFixture();
  seed(options.path, "live");
  await closeState();
  using writer = openNodeSqliteDatabase(options.path);
  writer.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE live_probe(value); INSERT INTO live_probe VALUES(1)",
  );
  const owner = acquireGatewayStateOwner({
    databasePath: options.path,
    payload: { ...defaultPayload(options.path), role: "gateway" },
  });
  const copies = [
    vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync"),
    vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation"),
    vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationAwaited"),
    vi.spyOn(snapshots, "startSqliteReadOnlyLocationAsync"),
  ];
  const probe: Parameters<typeof readSync>[0] = ({ db }) => {
    expect(() => db.exec("INSERT INTO live_probe VALUES(2)")).toThrow(/readonly/);
    return db.prepare("SELECT value FROM live_probe").get()?.value;
  };
  try {
    const command = { type: "plugins.deferredMigrations.read", input: undefined } as const;
    const readAwaited = () =>
      readExisting(options, command, { snapshotPreparation: "awaited" }).then(
        (reply) => reply?.pending,
      );
    await withSqliteSnapshotReuse(async () => {
      expect(preserveArtifacts(() => syncScope(() => readSync(probe, options)))).toBe(1);
      expect(await readAsync(probe, options)).toBe(1);
      expect(await readDeferredPluginMigrationsAsync(options)).toEqual([]);
      expect(await preserveArtifacts(readAwaited)).toEqual([]);
    });
    expect(await readDeferredPluginMigrationsAsync(options)).toEqual([]);
    expect(copies.map((copy) => copy.mock.calls.length)).toEqual([0, 0, 0, 0]);
    await preserveArtifacts(() =>
      frozenScope(() => readDeferredPluginMigrationsAsync(options), options),
    );
    expect(copies.map((copy) => copy.mock.calls.length)).toEqual([0, 0, 0, 1]);
  } finally {
    owner.release();
  }
  // Explicit online snapshots still share one backup and keep it until the last reader closes.
  openState(options);
  const sqlite = requireNodeSqlite();
  const backup = sqlite.backup.bind(sqlite);
  const started = createDeferredCore();
  const release = createDeferredCore();
  const backups = vi.spyOn(sqlite, "backup").mockImplementation(async (...args) => {
    started.resolve();
    await release.promise;
    return await backup(...args);
  });
  const firstSnapshot = snapshots.prepareSqliteReadOnlyLocation(options.path);
  await started.promise;
  const secondSnapshot = snapshots.prepareSqliteReadOnlyLocation(options.path);
  release.resolve();
  const [first, second] = await Promise.all([firstSnapshot, secondSnapshot]);
  try {
    expect(backups).toHaveBeenCalledOnce();
    expect(first.location).toBe(second.location);
    expect(first.cleanup()).toBe(true);
    expect(fs.existsSync(second.location)).toBe(true);
    using snapshot = openNodeSqliteDatabase(second.location, { readOnly: true });
    expect(snapshot.prepare("SELECT value FROM live_probe").get()).toEqual({ value: 1 });
    expect(
      snapshot
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
        .get("readonly.identity.fixture"),
    ).toEqual({ value_json: JSON.stringify({ source: "live" }) });
  } finally {
    await first.cleanupAsync();
    expect(await second.cleanupAsync()).toBe(true);
  }
  expect(fs.existsSync(second.location)).toBe(false);
});
