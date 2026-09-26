import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { retainCommandProcessCleanup } from "../process/exec-spawn.js";
import * as commands from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import { cleanupSnapshotOperations } from "./sqlite-readonly-location-cleanup.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";
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

it.each(
  (["metadata", "discover", "versions", "legacy-copy"] as const).flatMap((phase) =>
    (["forced", "uncertain"] as const).map((settlement) => ({ phase, settlement })),
  ),
)("retains $phase staging until command cleanup is $settlement", async ({ phase, settlement }) => {
  const { stateDir, file, writer } = fixture();
  const shared = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(shared));
  const registry = openNodeSqliteDatabase(shared);
  registry.exec("CREATE TABLE agent_databases(path TEXT); PRAGMA user_version=3;");
  registry.prepare("INSERT INTO agent_databases VALUES (?)").run(file);
  registry.close();
  const controller = new AbortController();
  const cleanup = createDeferredCore<"forced" | "uncertain">();
  const admitted = createDeferredCore();
  const roots = new Set<string>();
  let marker = "";
  const run = commands.runUtf8CommandWithTimeout;
  vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation(async (argv, options) => {
    if (typeof options === "number") {
      return run(argv, options);
    }
    const input = JSON.parse(String(options.input ?? "{}")) as {
      directory?: string;
      files?: string[];
      mode?: string;
    };
    const result = {
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
      stderr: "",
    };
    if (input.directory) {
      return { ...result, stdout: JSON.stringify({ facts: "0".repeat(64), bytes: 0 }) };
    }
    const current = input.files
      ? "metadata"
      : argv.includes(SQLITE_READONLY_CHILD_ARG)
        ? "legacy-copy"
        : input.mode;
    const stagingRoot = String(options.env?.XDG_CACHE_HOME);
    roots.add(stagingRoot);
    if (phase === "legacy-copy" && current === "discover") {
      options.onOutputChunk?.(Buffer.from("Unknown update state inspection mode"), "stderr");
      return { ...result, code: 1, stdout: "" };
    }
    if (current !== phase) {
      return run(argv, options);
    }
    marker = path.join(stagingRoot, "database.sqlite.partial");
    fs.writeFileSync(marker, "pending worker bytes");
    // Model the runner's bounded pre-readiness result separately from the
    // canonical cleanup promise that owns its late broker PID and close.
    retainCommandProcessCleanup(cleanup.promise);
    controller.abort(new Error("inspection canceled"));
    admitted.resolve();
    return { ...result, code: null, stdout: "", termination: "signal", cleanup: "uncertain" };
  });
  let finished = false;
  const operation = readUpdateStateSchemaVersions({
    stateDir,
    config: {},
    signal: controller.signal,
    env: { ...process.env, XDG_CACHE_HOME: path.join(stateDir, "cache") },
  });
  const outcome = operation
    .catch((error: unknown) => error)
    .finally(() => {
      finished = true;
    });
  let finalizing: Promise<void> | undefined;
  try {
    await admitted.promise;
    await setImmediate();
    expect.soft(finished).toBe(false);
    expect.soft(fs.existsSync(marker)).toBe(true);
    let finalized = false;
    finalizing = cleanupSnapshotOperations().finally(() => {
      finalized = true;
    });
    await setImmediate();
    expect.soft(finalized).toBe(false);
    expect.soft(fs.existsSync(marker)).toBe(true);
    cleanup.resolve(settlement);
    const failure = await outcome;
    await finalizing;
    expect(hasCommandProcessCleanupError(failure)).toBe(settlement === "uncertain");
    if (settlement === "uncertain") {
      expect(failure).toHaveProperty("message", expect.stringContaining("Staging retained at"));
      expect(failure).toHaveProperty(
        "message",
        expect.stringContaining(phase === "versions" ? file : shared),
      );
      expect(failure).toHaveProperty(
        "message",
        expect.stringContaining(
          phase === "metadata"
            ? "metadata inventory"
            : phase === "versions"
              ? "schema inspection startup"
              : "shared database discovery",
        ),
      );
      expect(failure).toHaveProperty(
        "message",
        expect.stringMatching(/after \d+(?:\.\d+)? seconds/),
      );
      for (const root of roots) {
        expect(fs.existsSync(root)).toBe(true);
      }
      expect(fs.readFileSync(marker, "utf8")).toBe("pending worker bytes");
    } else {
      expect(failure).toHaveProperty("message", "inspection canceled");
      for (const root of roots) {
        expect(fs.existsSync(root)).toBe(false);
      }
    }
    expect(writer.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
  } finally {
    cleanup.resolve("forced");
    await outcome;
    await finalizing;
    writer.close();
  }
});

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
    fs.mkdirSync(path.join(cache, "openclaw"));
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
    const now = Date.now.bind(Date);
    let elapsed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
    const operation = readUpdateStateSchemaVersions({
      stateDir,
      config: {},
      signal: controller.signal,
      env: { ...process.env, ...sqliteWorkerPreloadEnv(preload), XDG_CACHE_HOME: cache },
    });
    const rejected = operation.catch((error: unknown) => error);
    try {
      if (blocked) {
        await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), { timeout: 10_000 });
        if (outcome === "cancel") {
          controller.abort();
        } else {
          elapsed = 400_000;
        }
      }
      const failure = await rejected;
      if (outcome === "cancel") {
        expect(failure).toMatchObject({ name: "AbortError" });
      } else {
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toHaveProperty(
          "message",
          expect.stringMatching(
            outcome === "timeout" ? /made no progress/ : /native header (read|close) failed/,
          ),
        );
        expect.soft(failure).toHaveProperty("message", expect.stringContaining(file));
        expect
          .soft(failure)
          .toHaveProperty("message", expect.stringContaining("agent schema inspection"));
        expect
          .soft(failure)
          .toHaveProperty("message", expect.stringMatching(/after \d+(?:\.\d+)? seconds/));
        expect
          .soft(failure)
          .toHaveProperty("message", expect.stringContaining("then retry the update"));
      }
      const { pid } = JSON.parse(fs.readFileSync(marker, "utf8")) as { pid: number };
      expect(() => process.kill(pid, 0)).toThrow();
      expect(fs.readdirSync(cache)).toEqual(["openclaw", "unrelated.txt"]);
      expect(fs.readdirSync(path.join(cache, "openclaw"))).toEqual([]);
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

it.each(["", "-wal", "-shm", "-journal"])(
  "keeps an unknown size when %s metadata cannot be read",
  async (suffix) => {
    const root = dirs.make("openclaw-metadata-unknown-");
    const file = path.join(root, "database.sqlite");
    fs.writeFileSync(file, "database");
    const preload = writeMetadataFault(root, `${file}${suffix}`, false);
    await expect(
      readUpdateStateDatabaseSizes([file, path.join(root, "missing.sqlite")], {
        nodeRunner: process.execPath,
        sourceEnv: { ...process.env, ...sqliteWorkerPreloadEnv(preload) },
        stagingRoot: root,
      }),
    ).resolves.toEqual([{ path: file, sizeBytes: undefined }]);
  },
);

it.each(["", "-wal", "-shm", "-journal"])(
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
      env: { ...process.env, ...sqliteWorkerPreloadEnv(preload) },
    });
    const rejected = expect(inspection).rejects.toThrow("metadata cancellation");
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
