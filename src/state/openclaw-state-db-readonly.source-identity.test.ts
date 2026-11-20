import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { defaultPayload } from "../infra/gateway-state-owner-record.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "../infra/sqlite-private-directory.js";
import { cleanupSnapshotOperations } from "../infra/sqlite-readonly-location-cleanup.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { captureOpenClawStateReadWorkerContext } from "./openclaw-state-worker-context.js";

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    await cleanupSnapshotOperations();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  });
});

it("uses a live Gateway's WAL without copying while explicit discovery stays frozen", async () => {
  const root = directories.make("state-read-live-owner-");
  vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"));
  const options = {
    path: path.join(root, "state", "openclaw.sqlite"),
    env: { OPENCLAW_STATE_DIR: root, OPENCLAW_TEST_FAST: "1" },
  };
  openOpenClawStateDatabase(options);
  await closeOpenClawStateDatabaseAsync();
  using writer = openNodeSqliteDatabase(options.path);
  writer.exec("PRAGMA journal_mode=WAL");
  const owner = acquireGatewayStateOwner({
    databasePath: options.path,
    payload: { ...defaultPayload(options.path), role: "gateway" },
  });
  try {
    const key = "readonly.live-owner.fixture";
    const update = (value: number) =>
      writer
        .prepare(
          "INSERT OR REPLACE INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
        )
        .run(key, String(value), value);
    update(1);
    const copies = [
      vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync"),
      vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation"),
      vi.spyOn(snapshots, "startSqliteReadOnlyLocationAsync"),
    ];
    const probe: Parameters<
      typeof withExistingOpenClawStateDatabaseArtifactPreservingReadOnly
    >[0] = ({ db }) => {
      expect(() => db.exec("DELETE FROM config_machine_state")).toThrow(/readonly/);
      return db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?").get(key)
        ?.value_json;
    };
    const readAll = async () => {
      const sync = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(probe, options);
      const asyncCallback = await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
        probe,
        options,
      );
      const reply = await withArtifactPreservingStateReads(() =>
        executeExistingOpenClawStateRead(options, { type: "tui.lastSession.read", stateKey: key }),
      );
      return [sync, asyncCallback, reply?.ok ? reply.row?.value_json : undefined];
    };
    expect(await readAll()).toEqual(["1", "1", "1"]);
    expect(copies.map((copy) => copy.mock.calls.length)).toEqual([0, 0, 0]);
    await withOpenClawStateDatabaseReadSnapshot(async () => {
      update(2);
      expect(await readAll()).toEqual(["1", "1", "1"]);
    }, options);
    expect(await readAll()).toEqual(["2", "2", "2"]);
  } finally {
    owner.release();
  }
});

it("rejects successor bytes substituted after fresh validation and before snapshot preparation", async () => {
  const root = directories.make("state-read-source-identity-");
  vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"));
  const options = {
    path: path.join(root, "state", "openclaw.sqlite"),
    env: { OPENCLAW_STATE_DIR: root, OPENCLAW_TEST_FAST: "1" },
  };
  const replacement = path.join(root, "replacement.sqlite");
  const archived = path.join(root, "original.sqlite");
  const stateKey = "readonly.source-identity.fixture";
  const sources = [
    { pathname: options.path, value: "original" },
    { pathname: replacement, value: "successor" },
  ];
  for (const { pathname, value } of sources) {
    const database = openOpenClawStateDatabase({ ...options, path: pathname });
    database.db
      .prepare(
        "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
      )
      .run(stateKey, JSON.stringify({ source: value }), 1);
    database.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
  }
  // The measured read must take fresh snapshot preparation, never the cached native branch.
  await closeOpenClawStateDatabaseAsync();
  const originalIdentity = readDatabasePathIdentitySync(options.path);
  const replacementIdentity = readDatabasePathIdentitySync(replacement);
  expect(replacementIdentity.key).not.toBe(originalIdentity.key);
  const originalBytes = fs.readFileSync(options.path);
  const replacementBytes = fs.readFileSync(replacement);
  const context = captureOpenClawStateReadWorkerContext(options);
  expect(context.admission.identity.key).toBe(originalIdentity.key);

  const startPreparation = snapshots.startSqliteReadOnlyLocationAsync;
  const preparation = vi
    .spyOn(snapshots, "startSqliteReadOnlyLocationAsync")
    .mockImplementationOnce((pathname, preparationOptions) => {
      expect(pathname).toBe(options.path);
      // This real entry is reached only after the original fresh-validation operation settles.
      fs.renameSync(options.path, archived);
      fs.renameSync(replacement, options.path);
      return startPreparation(pathname, preparationOptions);
    });
  const outcome = await withArtifactPreservingStateReads(() =>
    executeExistingOpenClawStateRead(
      options,
      { type: "tui.lastSession.read", stateKey },
      { context },
    ),
  ).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

  expect(preparation).toHaveBeenCalledOnce();
  expect(readDatabasePathIdentitySync(options.path).key).toBe(replacementIdentity.key);
  expect(outcome).toHaveProperty("error");
  if (!("error" in outcome)) {
    throw new Error("The original read admission accepted a replacement database");
  }
  expect(
    collectNestedErrorCandidates(outcome.error).some(
      (error) => error instanceof Error && /identity|source.*changed/i.test(error.message),
    ),
  ).toBe(true);
  expect(fs.readFileSync(archived)).toEqual(originalBytes);
  expect(fs.readFileSync(options.path)).toEqual(replacementBytes);
});

it.runIf(process.platform === "darwin" && fs.existsSync("/usr/bin/SetFile"))(
  "reads the admitted source after a same-inode birthtime metadata change",
  async () => {
    const root = directories.make("state-read-birthtime-");
    vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"));
    const options = {
      path: path.join(root, "state", "openclaw.sqlite"),
      env: { OPENCLAW_STATE_DIR: root, OPENCLAW_TEST_FAST: "1" },
    };
    const stateKey = "readonly.birthtime.fixture";
    const value = JSON.stringify({ source: "original" });
    const database = openOpenClawStateDatabase(options);
    database.db
      .prepare(
        "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
      )
      .run(stateKey, value, 1);
    database.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    await closeOpenClawStateDatabaseAsync();
    const context = captureOpenClawStateReadWorkerContext(options);
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
    expect(
      await withArtifactPreservingStateReads(() =>
        executeExistingOpenClawStateRead(
          options,
          { type: "tui.lastSession.read", stateKey },
          { context },
        ),
      ),
    ).toMatchObject({
      ok: true,
      type: "tui.lastSession.read",
      row: { value_json: value, updated_at_ms: 1 },
    });
    await closeOpenClawStateDatabaseAsync();
    await cleanupSnapshotOperations();
    expect(fs.readdirSync(stagingRoot).toSorted()).toEqual(stagingBefore);
    expect(fs.readFileSync(options.path)).toEqual(sourceBytes);
    expect(fs.readdirSync(path.dirname(options.path)).toSorted()).toEqual(sourceFiles);
    const retained = fs.statSync(options.path, { bigint: true });
    expect([retained.dev, retained.ino, retained.birthtimeNs]).toEqual([
      after.dev,
      after.ino,
      after.birthtimeNs,
    ]);
  },
);

function source() {
  const pathname = path.join(directories.make("openclaw-readonly-exclusion-"), "openclaw.sqlite");
  const owner = openOpenClawStateDatabase({ path: pathname });
  owner.db
    .prepare(
      "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
    )
    .run("readonly-exclusion", "preserved", "{}", 1);
  closeOpenClawStateDatabaseForTest();
  return pathname;
}

it("shares one online backup across concurrent snapshots of the live state owner", async () => {
  const pathname = source();
  const owner = openOpenClawStateDatabase({ path: pathname });
  owner.db
    .prepare(
      "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
    )
    .run("readonly-exclusion", "single-flight", "{}", 2);
  const sqlite = await import("../infra/node-sqlite.js").then((module) =>
    module.requireNodeSqlite(),
  );
  const backup = sqlite.backup.bind(sqlite);
  let backupCalls = 0;
  const started = createDeferredCore();
  const release = createDeferredCore();
  vi.spyOn(sqlite, "backup").mockImplementation(async (...args) => {
    backupCalls += 1;
    started.resolve();
    await release.promise;
    return await backup(...args);
  });

  const firstSnapshot = snapshots.prepareSqliteReadOnlyLocation(pathname);
  await started.promise;
  const secondSnapshot = snapshots.prepareSqliteReadOnlyLocation(pathname);
  release.resolve();
  const [first, second] = await Promise.all([firstSnapshot, secondSnapshot]);
  try {
    expect(backupCalls).toBe(1);
    expect(first.location).toBe(second.location);
    expect(first.cleanup()).toBe(true);
    expect(fs.existsSync(second.location)).toBe(true);
    const snapshot = openNodeSqliteDatabase(second.location, { readOnly: true });
    try {
      expect(
        snapshot
          .prepare("SELECT event_key FROM diagnostic_events WHERE scope = ? ORDER BY created_at")
          .all("readonly-exclusion"),
      ).toEqual([{ event_key: "preserved" }, { event_key: "single-flight" }]);
    } finally {
      snapshot.close();
    }
  } finally {
    await first.cleanupAsync();
    expect(await second.cleanupAsync()).toBe(true);
  }
  expect(fs.existsSync(second.location)).toBe(false);
});
