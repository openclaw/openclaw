import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as commands from "../process/exec.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";
import { acquireStateDatabaseHandleExclusion } from "./state-database-coordinator.js";
import { readUpdateStateSchemaVersions } from "./update-candidate-state.js";
import { readUpdateStateDatabaseSizes } from "./update-candidate-state.sizes.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  }),
);

// Keep the fixture's writer open for native lock and failure probes.
function fixture() {
  const stateDir = fs.realpathSync(dirs.make("update-schema-lifetime-"));
  const file = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const writer = openNodeSqliteDatabase(file);
  writer.exec("PRAGMA user_version=3;");
  return { stateDir, file, writer };
}

it("preserves the parent agent writer lock and excludes its uncommitted migration", async () => {
  const { stateDir, file, writer } = fixture();
  writer.exec("BEGIN IMMEDIATE; PRAGMA user_version=4;");
  try {
    const versions = await readUpdateStateSchemaVersions({ stateDir, config: {} });
    expect(versions).toContainEqual({ path: file, userVersion: 3 });
    const competitor = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(process.argv[1]);
        try {
          db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK;');
          process.exitCode = 2;
        } catch(error) {
          if (error.errcode !== 5) throw error;
          process.stdout.write('writer refused');
        } finally { db.close(); }
      `,
        file,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(competitor.status, competitor.stderr).toBe(0);
    expect(competitor.stdout).toBe("writer refused");
    expect(writer.isTransaction).toBe(true);
  } finally {
    writer.exec("ROLLBACK;");
    writer.close();
  }
});

it.each(["timeout", "cancel", "read-failure", "close-failure"] as const)(
  "settles the schema worker before releasing ownership after %s",
  async (outcome) => {
    const { stateDir, file, writer } = fixture();
    const blocked = outcome === "timeout" || outcome === "cancel";
    if (blocked) {
      writer.exec("BEGIN EXCLUSIVE; PRAGMA user_version=4;");
    }
    const marker = path.join(stateDir, "native-read.json");
    const cache = path.join(stateDir, "cache");
    fs.mkdirSync(cache);
    const sentinel = path.join(cache, "unrelated.txt");
    fs.writeFileSync(sentinel, "preserved");
    const preload = path.join(stateDir, "native-fault.cjs");
    // Fault the real source connection inside the launched worker. A held
    // exclusive writer exercises SQLite's blocking read, not a sleeping stand-in.
    fs.writeFileSync(
      preload,
      `
      const fs = require('node:fs'), path = require('node:path');
      const { DatabaseSync } = require('node:sqlite');
      const source = ${JSON.stringify(file)}, marker = ${JSON.stringify(marker)};
      const outcome = ${JSON.stringify(outcome)};
      const isSource = db => db.location() && path.toNamespacedPath(db.location()) === path.toNamespacedPath(source);
      const prepare = DatabaseSync.prototype.prepare, close = DatabaseSync.prototype.close;
      DatabaseSync.prototype.prepare = function(sql) {
        if (isSource(this) && sql === 'PRAGMA user_version') {
          fs.writeFileSync(marker, JSON.stringify({pid:process.pid}));
          if (outcome === 'read-failure') throw new Error('native header read failed');
        }
        return prepare.call(this, sql);
      };
      DatabaseSync.prototype.close = function() {
        if (isSource(this) && outcome === 'close-failure') throw new Error('native header close failed');
        return close.call(this);
      };
    `,
    );
    const controller = new AbortController();
    const run = commands.runCommandBuffered;
    vi.spyOn(commands, "runCommandBuffered").mockImplementation((argv, options) => {
      if (argv.includes("--eval")) {
        return run(argv, options);
      }
      expect(options).toMatchObject({ killGraceMs: 500 });
      expect(options?.timeoutMs).toBeGreaterThanOrEqual(30_000);
      return run(argv, {
        ...options,
        // Shorten only the test's wait; assert the real production budget above.
        ...(outcome === "timeout" ? { timeoutMs: 2500 } : {}),
        signal: controller.signal,
      });
    });
    const operation = readUpdateStateSchemaVersions({
      stateDir,
      config: {},
      env: { ...process.env, ...sqliteWorkerPreloadEnv(preload), XDG_CACHE_HOME: cache },
    });
    const failure =
      outcome === "timeout"
        ? /failed \(timeout(?:, signal [^)]+)?\)/
        : outcome === "cancel"
          ? /failed \(signal(?:, signal [^)]+)?\)/
          : /native header (read|close) failed/;
    const rejected = expect(operation).rejects.toThrow(failure);
    try {
      if (outcome === "cancel") {
        await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), { timeout: 10_000 });
        controller.abort();
      }
      await rejected;
      const { pid } = JSON.parse(fs.readFileSync(marker, "utf8")) as { pid: number };
      expect(() => process.kill(pid, 0)).toThrow();
      acquireStateDatabaseHandleExclusion({ databasePath: file, busyTimeoutMs: 0 }).release();
      expect(fs.readdirSync(cache)).toEqual(["unrelated.txt"]);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("preserved");
      expect(writer.prepare("PRAGMA user_version").get()).toEqual({
        user_version: blocked ? 4 : 3,
      });
    } finally {
      controller.abort();
      await Promise.allSettled([operation, rejected]);
      if (writer.isTransaction) {
        writer.exec("ROLLBACK;");
      }
      writer.close();
    }
  },
  15_000,
);

// Inject metadata faults only in the child; the parent must remain able to cancel it.
function writeMetadataFault(root: string, target: string, block: boolean): string {
  const preload = path.join(root, "metadata-fault.cjs");
  fs.writeFileSync(
    preload,
    `
    const fs = require("node:fs");
    const stat = fs.statSync;
    fs.statSync = function(file, ...args) {
      if (file === ${JSON.stringify(target)}) {
        if (${block}) {
          process.on("SIGTERM", () => {});
          fs.writeFileSync(${JSON.stringify(path.join(root, "started.json"))}, JSON.stringify({
            pid: process.pid, stagingRoot: process.env.XDG_CACHE_HOME,
          }));
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        throw Object.assign(new Error("metadata unavailable"), { code: "EIO" });
      }
      return stat.call(this, file, ...args);
    };
    `,
  );
  return preload;
}

it.each(["", "-wal", "-journal"])(
  "keeps an unknown size when %s metadata cannot be read",
  async (suffix) => {
    const root = dirs.make("openclaw-metadata-unknown-");
    const file = path.join(root, "database.sqlite");
    fs.writeFileSync(file, "database");
    const preload = writeMetadataFault(root, `${file}${suffix}`, false);
    await expect(
      readUpdateStateDatabaseSizes([file, path.join(root, "missing.sqlite")], {
        nodeRunner: process.execPath,
        sourceEnv: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
        stagingRoot: root,
      }),
    ).resolves.toEqual([{ path: file, sizeBytes: undefined }]);
  },
);

it.each(["", "-wal", "-journal"])(
  "cancels blocked %s metadata before candidate discovery and removes staging after child exit",
  async (suffix) => {
    const root = dirs.make("openclaw-metadata-cancel-");
    const file = path.join(root, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "database");
    const preload = writeMetadataFault(root, `${file}${suffix}`, true);
    const controller = new AbortController();
    const inspection = readUpdateStateSchemaVersions({
      stateDir: root,
      config: {},
      // No candidate worker exists: cancellation must happen during metadata inventory.
      root: path.join(root, "unavailable-candidate"),
      signal: controller.signal,
      env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
    });
    const rejected = expect(inspection).rejects.toThrow();
    let report: { pid: number; stagingRoot: string } | undefined;
    try {
      await vi.waitFor(() => {
        report = JSON.parse(fs.readFileSync(path.join(root, "started.json"), "utf8"));
        expect(report).toBeDefined();
      });
      expect(fs.existsSync(report!.stagingRoot)).toBe(true);
    } finally {
      controller.abort(new Error("metadata cancellation"));
      await rejected;
    }
    expect(() => process.kill(report!.pid, 0)).toThrow();
    expect(fs.existsSync(report!.stagingRoot)).toBe(false);
  },
);
