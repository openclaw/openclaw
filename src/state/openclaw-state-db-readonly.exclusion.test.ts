import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  prepareSqliteReadOnlyLocation,
  withSqliteSnapshotSource,
} from "../infra/sqlite-snapshot-source.js";
import { acquireStateDatabaseHandleExclusion } from "../infra/state-database-coordinator.js";
import { stateNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import { acquireOpenClawStateDatabaseFileExclusion } from "./openclaw-state-db-cache.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function source() {
  const pathname = path.join(dirs.make("openclaw-readonly-exclusion-"), "openclaw.sqlite");
  const owner = openOpenClawStateDatabase({ path: pathname });
  owner.db
    .prepare(
      "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
    )
    .run("readonly-exclusion", "preserved", "{}", 1);
  closeOpenClawStateDatabaseForTest();
  return pathname;
}

it("keeps a fresh live read inside the physical handle barrier", async () => {
  const pathname = source();
  const rows = withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => {
      let excluded = false;
      let exclusion: ReturnType<typeof acquireStateDatabaseHandleExclusion> | undefined;
      try {
        exclusion = acquireStateDatabaseHandleExclusion({ databasePath: pathname });
      } catch (error) {
        expect(String(error)).toMatch(/state-handles/);
        excluded = true;
      } finally {
        exclusion?.release();
      }
      expect(excluded).toBe(true);
      return db
        .prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?")
        .all("readonly-exclusion");
    },
    { path: pathname },
  );
  expect(rows).toEqual([{ event_key: "preserved" }]);
  (await acquireOpenClawStateDatabaseFileExclusion(pathname)).release();
});

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
  vi.spyOn(sqlite, "backup").mockImplementation(async (...args) => {
    backupCalls += 1;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    return await backup(...args);
  });

  const [first, second] = await Promise.all([
    prepareSqliteReadOnlyLocation(pathname),
    prepareSqliteReadOnlyLocation(pathname),
  ]);
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

it("refuses a new live readonly handle without touching an excluded source", async () => {
  const pathname = source();
  const exclusion = await acquireOpenClawStateDatabaseFileExclusion(pathname);
  const before = fs.statSync(pathname, { bigint: true });
  try {
    expect(() =>
      withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => db.prepare("PRAGMA user_version").get(),
        { path: pathname },
      ),
    ).toThrow(/state-handles/);
    expect(fs.statSync(pathname, { bigint: true })).toEqual(before);
  } finally {
    exclusion.release();
  }
  expect(
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) =>
        db
          .prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?")
          .all("readonly-exclusion"),
      { path: pathname },
    ),
  ).toEqual([{ event_key: "preserved" }]);
});

it("keeps the source-copy child's own handle lease until its actual backup settles", async () => {
  const pathname = source();
  const setup = openNodeSqliteDatabase(pathname);
  setup.exec("PRAGMA journal_mode=DELETE");
  setup.close();
  const locationModule = resolveRuntimeWorkerUrl(
    stateNativeProcessEntrypoints.sqliteReadOnlyLocation,
  );
  const sqliteModule = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.nodeSqlite);
  const child = spawn(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(locationModule).slice(0, -1),
      "--input-type=module",
      "--eval",
      `
    import { once } from "node:events";
    import { requireNodeSqlite } from ${JSON.stringify(sqliteModule.href)};
    import { prepareSqliteReadOnlyLocationInProcess } from ${JSON.stringify(locationModule.href)};
    const sqlite = requireNodeSqlite();
    const backup = sqlite.backup.bind(sqlite);
    sqlite.backup = async (...args) => {
      const result = await backup(...args);
      const release = once(process, "message");
      process.send({ ready: true });
      await release;
      return result;
    };
    const prepared = await prepareSqliteReadOnlyLocationInProcess(process.argv[1]);
    const copied = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
    const rows = copied.prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?").all("readonly-exclusion");
    copied.close();
    prepared.cleanup();
    process.send({ rows });
    process.disconnect();
  `,
      pathname,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  try {
    const [ready] = await once(child, "message", { signal: AbortSignal.timeout(15_000) });
    expect(ready).toEqual({ ready: true });
    let excluded = false;
    let exclusion:
      | Awaited<ReturnType<typeof acquireOpenClawStateDatabaseFileExclusion>>
      | undefined;
    try {
      exclusion = await acquireOpenClawStateDatabaseFileExclusion(pathname);
    } catch (error) {
      expect(String(error)).toMatch(/state-handles/);
      excluded = true;
    } finally {
      exclusion?.release();
    }
    expect(excluded).toBe(true);
    const done = once(child, "message", { signal: AbortSignal.timeout(10_000) });
    const closed = once(child, "close", { signal: AbortSignal.timeout(10_000) });
    child.send({ release: true });
    expect((await done)[0]).toEqual({ rows: [{ event_key: "preserved" }] });
    await closed;
    (await acquireOpenClawStateDatabaseFileExclusion(pathname)).release();
  } finally {
    await stopChildProcess(child, 5_000);
  }
});

it("keeps a live-path snapshot callback excluded until its actual reader closes", async () => {
  const pathname = source();
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const copying = withSqliteSnapshotSource(pathname, async (location) => {
    expect(location).toBe(pathname);
    const reader = openNodeSqliteDatabase(location, { readOnly: true });
    try {
      entered();
      await paused;
      return reader
        .prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?")
        .all("readonly-exclusion");
    } finally {
      reader.close();
    }
  });
  try {
    await started;
    let excluded = false;
    let exclusion:
      | Awaited<ReturnType<typeof acquireOpenClawStateDatabaseFileExclusion>>
      | undefined;
    try {
      exclusion = await acquireOpenClawStateDatabaseFileExclusion(pathname);
    } catch (error) {
      expect(String(error)).toMatch(/state-handles/);
      excluded = true;
    } finally {
      exclusion?.release();
    }
    expect(excluded).toBe(true);
  } finally {
    resume();
  }
  expect(await copying).toEqual([{ event_key: "preserved" }]);
  (await acquireOpenClawStateDatabaseFileExclusion(pathname)).release();
});
