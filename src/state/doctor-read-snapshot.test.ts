import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, expect, it, vi } from "vitest";
import { waitForFixtureFile } from "../../test/helpers/process-wait.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SqliteSnapshotCleanupError } from "../infra/sqlite-readonly-location-cleanup.js";
import type { RetainedPreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import * as snapshotWorker from "../infra/sqlite-readonly-worker.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import { readOpenClawDatabaseQuarantineFailure } from "./openclaw-quarantine-store.js";
import { seedOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.test-support.js";
import {
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
  withOpenClawStateDatabaseReadOnly,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { resolveQuarantineStorePath } from "./openclaw-state-db.paths.js";
import type { OpenClawStateReadOnlyDatabase } from "./openclaw-state-read.types.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function sourceFamily(pathname: string) {
  return ["", "-wal", "-shm", "-journal"].map((suffix) => {
    const file = `${pathname}${suffix}`;
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  });
}

function forbidSynchronousSnapshot() {
  return vi.spyOn(snapshotWorker, "runSqliteReadOnlyWorkerSync").mockImplementation(() => {
    throw new Error("Doctor must not prepare an inspection snapshot synchronously");
  });
}

it.each(["snapshot", "reader"] as const)(
  "prepares cold quarantine decisions before the async %s reads shared state",
  async (owner) => {
    const root = directories.make("doctor-quarantine-read-");
    const env = { OPENCLAW_STATE_DIR: root };
    vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"));
    const state = openOpenClawStateDatabase({ env });
    state.db.exec(
      "CREATE TABLE retained_probe(value TEXT); INSERT INTO retained_probe VALUES ('kept')",
    );
    const statePath = state.path;
    await closeOpenClawStateDatabaseAsync();
    const quarantined = path.join(root, "other-agent.sqlite");
    seedOpenClawDatabaseQuarantine({
      env,
      path: quarantined,
      kind: "agent",
      reason: "known damage",
    });
    const quarantinePath = resolveQuarantineStorePath(env);
    const original = [sourceFamily(statePath), sourceFamily(quarantinePath)];
    const synchronous = forbidSynchronousSnapshot();
    const read = ({ db }: OpenClawStateReadOnlyDatabase) => {
      expect(readOpenClawDatabaseQuarantineFailure("agent", quarantined, { env })).toMatchObject({
        name: "SqliteIntegrityError",
        message: expect.stringContaining("known damage"),
      });
      return db.prepare("SELECT value FROM retained_probe").get();
    };
    const result = await withArtifactPreservingStateReads(
      () =>
        owner === "reader"
          ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(read, { env })
          : withOpenClawStateDatabaseReadSnapshot(
              async () => withOpenClawStateDatabaseReadOnly(read, { env }),
              { env },
            ),
      { agentDatabases: true },
    );
    expect(result).toEqual({ value: "kept" });
    expect(synchronous).not.toHaveBeenCalled();
    expect([sourceFamily(statePath), sourceFamily(quarantinePath)]).toEqual(original);
    expect(fs.readdirSync(path.join(root, "cache", "openclaw"))).toEqual([]);
  },
);

it.each(["absent", "broken", "preparation failed", "cached quarantine"] as const)(
  "keeps the quarantine owner's %s policy without synchronous fallback",
  async (kind) => {
    const root = directories.make("doctor-quarantine-policy-");
    const env = { OPENCLAW_STATE_DIR: root };
    vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"));
    const pathname = path.join(root, "agent.sqlite");
    const storePath = resolveQuarantineStorePath(env);
    if (kind !== "absent") {
      seedOpenClawDatabaseQuarantine({
        env,
        path: pathname,
        kind: "agent",
        reason: "recorded damage",
      });
      if (kind === "broken") {
        fs.writeFileSync(storePath, "broken advisory index");
      }
    }
    const expected =
      kind === "cached quarantine"
        ? expect.objectContaining({
            name: "SqliteIntegrityError",
            message: expect.stringContaining("recorded damage"),
          })
        : undefined;
    if (kind === "cached quarantine") {
      expect(readOpenClawDatabaseQuarantineFailure("agent", pathname, { env })).toEqual(expected);
    }
    if (kind === "preparation failed" || kind === "cached quarantine") {
      vi.spyOn(snapshotWorker, "runSqliteReadOnlyWorker").mockRejectedValue(
        new Error("advisory source unavailable"),
      );
    }
    const original = sourceFamily(storePath);
    const synchronous = forbidSynchronousSnapshot();
    await withArtifactPreservingStateReads(
      () =>
        withOpenClawStateDatabaseReadSnapshot(
          async () => {
            // Missing STATE must still prepare its retained auxiliary admission source.
            for (let read = 0; read < 2; read++) {
              expect(readOpenClawDatabaseQuarantineFailure("agent", pathname, { env })).toEqual(
                expected,
              );
            }
          },
          { env },
        ),
      { agentDatabases: true },
    );
    expect(synchronous).not.toHaveBeenCalled();
    expect(sourceFamily(storePath)).toEqual(original);
    if (kind === "absent") {
      expect(fs.existsSync(path.join(root, "state"))).toBe(false);
    } else {
      expect(fs.readdirSync(path.join(root, "cache", "openclaw"))).toEqual([]);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "cancels the Doctor quarantine copy and joins its child and private image cleanup",
  { timeout: 10_000 },
  async ({ signal }) => {
    const root = directories.make("doctor-quarantine-cancel-");
    const env = { OPENCLAW_STATE_DIR: root };
    const pathname = path.join(root, "agent.sqlite");
    seedOpenClawDatabaseQuarantine({ env, path: pathname, kind: "agent", reason: "preserved" });
    const original = sourceFamily(resolveQuarantineStorePath(env));
    vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"));
    const ready = path.join(root, "ready");
    const preload = path.join(root, "hold-copy.mjs");
    fs.writeFileSync(
      preload,
      `
      import fs from "node:fs";
      const open = fs.openSync;
      fs.openSync = (pathname, ...args) => {
        const descriptor = open(pathname, ...args);
        if (String(pathname).endsWith("database.sqlite.partial") && process.argv.includes("--openclaw-sqlite-readonly-child")) {
          fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, partial: String(pathname) }));
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        return descriptor;
      };
    `,
    );
    vi.stubEnv(
      process.versions.bun ? "BUN_OPTIONS" : "NODE_OPTIONS",
      `${process.versions.bun ? "--preload" : "--import"}=${pathToFileURL(preload).href}`,
    );
    const synchronous = forbidSynchronousSnapshot();
    const controller = new AbortController();
    const cancelled = new Error("Doctor interrupted by SIGTERM");
    const operation = vi.fn(async () => "must not enter");
    const reading = withArtifactPreservingStateReads(
      () => withOpenClawStateDatabaseReadSnapshot(operation, { env, signal: controller.signal }),
      { agentDatabases: true },
    );
    void reading.catch(() => {});
    try {
      expect(operation).not.toHaveBeenCalled();
      await withinTest(waitForFixtureFile(ready, reading), signal);
      const { pid, partial } = JSON.parse(fs.readFileSync(ready, "utf8"));
      expect(fs.existsSync(partial)).toBe(true);
      controller.abort(cancelled);
      await expect(reading).rejects.toBe(cancelled);
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      expect(operation).not.toHaveBeenCalled();
      expect(synchronous).not.toHaveBeenCalled();
      expect(fs.readdirSync(path.join(root, "cache", "openclaw"))).toEqual([]);
      expect(sourceFamily(resolveQuarantineStorePath(env))).toEqual(original);
    } finally {
      controller.abort(cancelled);
      await Promise.allSettled([reading]);
    }
  },
);

it("does not downgrade quarantine snapshot cleanup failure into an absent decision", async () => {
  const root = directories.make("doctor-quarantine-cleanup-");
  const env = { OPENCLAW_STATE_DIR: root };
  vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"));
  seedOpenClawDatabaseQuarantine({
    env,
    path: path.join(root, "agent.sqlite"),
    kind: "agent",
    reason: "preserved",
  });
  const failure = new SqliteSnapshotCleanupError("auxiliary snapshot cleanup failed");
  vi.spyOn(snapshotWorker, "runSqliteReadOnlyWorker").mockRejectedValue(failure);
  const operation = vi.fn(async () => "must not enter");
  const synchronous = forbidSynchronousSnapshot();
  await expect(
    withArtifactPreservingStateReads(
      () => withOpenClawStateDatabaseReadSnapshot(operation, { env }),
      { agentDatabases: true },
    ),
  ).rejects.toBe(failure);
  expect(operation).not.toHaveBeenCalled();
  expect(synchronous).not.toHaveBeenCalled();
  expect(fs.readdirSync(path.join(root, "cache", "openclaw"))).toEqual([]);
});

it("lets Doctor cancel a pending lazy schema snapshot without blocking signal delivery", async () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("doctor-lazy-cancellation-") };
  const pathname = path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(pathname));
  fs.writeFileSync(pathname, "pending inspection source");
  const controller = new AbortController();
  const cancelled = new Error("Doctor interrupted by SIGTERM");
  // Bound the broken synchronous path so this regression fails instead of hanging.
  vi.spyOn(snapshotWorker, "readSqliteInspectionBudget").mockReturnValue({
    timeoutMs: 10,
    size: "fixture",
  });
  const closed = vi.fn();
  vi.spyOn(snapshots, "startSqliteReadOnlyLocationAsync").mockImplementation(() => {
    const retained = createRetainedOperation<RetainedPreparedSqliteReadOnlyLocation>(() => {});
    controller.signal.addEventListener("abort", () => retained.reject(cancelled), { once: true });
    queueMicrotask(() => controller.abort(cancelled));
    return {
      ...retained.operation,
      startClose() {
        closed();
        const close = createRetainedOperation<void>(() => {});
        close.resolve(undefined);
        return close.operation;
      },
    };
  });
  await expect(
    withOpenClawStateDatabaseReadSnapshot(
      () => preflightOpenClawDatabaseSchemas({ env, scope: "state", signal: controller.signal }),
      { env, lazy: true, signal: controller.signal },
    ),
  ).rejects.toBe(cancelled);
  expect(closed).toHaveBeenCalledOnce();
});
