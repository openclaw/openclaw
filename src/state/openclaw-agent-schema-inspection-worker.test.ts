import { execFile, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqlite from "../infra/node-sqlite.js";
import * as sqliteInspection from "../infra/sqlite-readonly-worker.js";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "./openclaw-agent-db-migration-required.js";
import { createAgentSchemaInspectionWorker } from "./openclaw-agent-schema-inspection-worker.js";
import { preflightAgentDatabasesBounded } from "./openclaw-database-preflight-agent-scheduler.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: vi.fn(actual.fork) };
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createSource(sql: string) {
  const pathname = path.join(tempDirs.make("agent-schema-inspection-"), "source.sqlite");
  using database = sqlite.openNodeSqliteDatabase(pathname);
  database.exec(sql);
  return pathname;
}

function observeChild() {
  const child = vi.mocked(fork).mock.results.at(-1)?.value;
  const closed = vi.fn();
  child.once("close", closed);
  return { child, closed };
}

it("hands its prestarted child to the first scheduler slot without spending inspection time", async () => {
  const pathname = createSource("CREATE TABLE probe(value TEXT); PRAGMA user_version = 1;");
  await using reader = createAgentSchemaInspectionWorker();
  vi.mocked(fork).mockClear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const budget = vi.spyOn(sqliteInspection, "readSqliteInspectionBudget").mockReturnValue({
    timeoutMs: 1_000,
    size: "fixture",
  });
  try {
    reader.prestart();
    const { child, closed } = observeChild();
    // Discovery can outlast an inspection's entire budget; only the eventual read spends it.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.killed).toBe(false);
    let available: typeof reader | undefined = reader;
    const stats = await preflightAgentDatabasesBounded(
      [pathname],
      async (target, _inspection, _claim, inspect) => {
        const result = await inspect({ pathname: target, supportedVersion: 1 });
        expect(result).toMatchObject({ version: 1, failure: undefined });
      },
      { incompatible: [], indeterminate: [] },
      undefined,
      undefined,
      () => {
        const transferred = available;
        available = undefined;
        return transferred;
      },
    );
    expect(stats).toEqual({
      schemaProcessCount: 1,
      schemaInspectionCount: 1,
      schemaSnapshotCount: 0,
    });
    expect(fork).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  } finally {
    budget.mockRestore();
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "reports cold state seal admission (prior schema=%s)",
  async (priorSchema) => {
    const directory = tempDirs.make("state-schema-contract-transfer-");
    // The ordinary test pool is an unhosted worker; only a real process owns seal custody.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        ...(process.versions.bun ? ["--no-install"] : ["--import", import.meta.resolve("tsx")]),
        "--input-type=module",
        "--eval",
        `import { registerHooks } from 'node:module';
       import { readFileSync } from 'node:fs';
       const schemaUrl = ${JSON.stringify(new URL("./openclaw-state-schema.ts", import.meta.url).href)};
       if (${priorSchema}) registerHooks({ load(url, context, nextLoad) {
         if (url !== schemaUrl) return nextLoad(url, context);
         const sql = readFileSync(${JSON.stringify(fileURLToPath(new URL("./openclaw-state-schema.sql", import.meta.url)))}, 'utf8').replace('  bootstrap_deferred INTEGER,\\n', '');
         return { format: 'module', shortCircuit: true, source: 'export const OPENCLAW_STATE_SCHEMA_SQL = ' + JSON.stringify(sql) };
       }});
       const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } = await import(${JSON.stringify(new URL("./openclaw-state-db.ts", import.meta.url).href)});
       const state = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: ${JSON.stringify(directory)} } });
       await closeOpenClawStateDatabaseAsync();
       console.log(state.path);`,
      ],
      { timeout: 30_000 },
    );
    const pathname = stdout.trim();
    expect(fs.existsSync(`${pathname}.seal`)).toBe(true);
    const ddlLog = path.join(directory, "comparison-ddl.log");
    const preload = path.join(directory, "observe-comparison-ddl.cjs");
    fs.writeFileSync(ddlLog, "");
    fs.writeFileSync(
      preload,
      `const fs = require('node:fs');
const { DatabaseSync, StatementSync } = require('node:sqlite');
for (const method of ['all', 'get', 'iterate']) {
  const read = StatementSync.prototype[method];
  StatementSync.prototype[method] = function(...args) {
    if (/^PRAGMA (?:integrity|quick|foreign_key)_check/i.test(this.sourceSQL)) {
      fs.appendFileSync(${JSON.stringify(ddlLog)}, this.sourceSQL + '\\n');
    }
    return read.apply(this, args);
  };
}
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  if (this.location() === null && /CREATE TABLE/i.test(sql)) {
    fs.appendFileSync(${JSON.stringify(ddlLog)}, 'comparison\\n');
  }
  return exec.call(this, sql);
};`,
    );
    await withEnvAsync(sqliteWorkerPreloadEnv(preload), async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await using reader = createAgentSchemaInspectionWorker();
        const result = await reader.inspectState(
          {
            pathname,
            supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
            verifyCurrentSchemaShape: true,
            requireStartupMigrationReadiness: true,
            purpose: "runtime",
            scope: "state",
          },
          undefined,
        );
        expect(result?.schemas).toEqual({ incompatible: [], indeterminate: [] });
        if (priorSchema) {
          expect(fs.readFileSync(ddlLog, "utf8")).toContain("PRAGMA integrity_check");
          expect(result?.startupMetrics).toEqual({
            stateIntegrityCheckCount: 1,
            stateIntegrityMs: expect.any(Number),
            stateSealCount: 0,
            stateIntegrityReason: "schema-mismatch",
          });
        } else {
          expect(fs.readFileSync(ddlLog, "utf8")).toBe("");
          expect(result?.startupMetrics).toEqual({
            stateIntegrityCheckCount: 0,
            stateIntegrityMs: 0,
            stateSealCount: 1,
          });
        }
      }
      // An external write invalidates the real close receipt; fresh inspection must refuse it.
      using writer = new (sqlite.requireNodeSqlite().DatabaseSync)(pathname);
      writer.exec(`PRAGMA foreign_keys=OFF;
      INSERT INTO acp_replay_events
        (session_id, seq, at, session_key, run_id, update_json, estimated_bytes)
        VALUES ('missing-session', 1, 10, 'session', NULL, '{}', 0)`);
      await using reader = createAgentSchemaInspectionWorker();
      await expect(
        reader.inspectState(
          {
            pathname,
            supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
            requireStartupMigrationReadiness: true,
            purpose: "runtime",
            scope: "state",
          },
          undefined,
        ),
      ).rejects.toThrow(/foreign_key_check/);
      expect(fs.readFileSync(ddlLog, "utf8")).toContain("PRAGMA integrity_check");
    });
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "agentSchemaInspection child names a native snapshot-open refusal and reuses a healthy replacement",
  async () => {
    const pathname = createSource(
      "CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('unchanged');",
    );
    const snapshot = path.join(path.dirname(pathname), "snapshot.sqlite");
    fs.copyFileSync(pathname, snapshot);
    const before = fs.readFileSync(pathname);
    const identity = fs.statSync(snapshot, { bigint: true });
    try {
      await using reader = createAgentSchemaInspectionWorker();
      fs.chmodSync(snapshot, 0);
      const inspection = reader.inspect({ pathname, supportedVersion: 21 }, undefined, snapshot);
      const { closed } = observeChild();
      const failure = await inspection.catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "ERR_SQLITE_ERROR",
        errcode: 14,
      });
      expect(closed).toHaveBeenCalledOnce();
      expect(fs.statSync(snapshot, { bigint: true })).toMatchObject({
        dev: identity.dev,
        ino: identity.ino,
        size: identity.size,
      });
      expect(fs.readFileSync(pathname)).toEqual(before);
      fs.chmodSync(snapshot, 0o600);
      expect(fs.readFileSync(snapshot)).toEqual(before);
      for (let request = 0; request < 2; request += 1) {
        await expect(
          reader.inspect({ pathname, supportedVersion: 21 }, undefined, snapshot),
        ).resolves.toMatchObject({ version: 0, failure: undefined });
      }
      expect([reader.processCount, reader.inspectionCount, reader.snapshotCount]).toEqual([
        2, 2, 2,
      ]);
      expect([pathname, snapshot].map((location) => fs.readFileSync(location))).toEqual([
        before,
        before,
      ]);
    } finally {
      fs.chmodSync(snapshot, 0o600);
    }
  },
);

it("agentSchemaInspection carries a Proxy env across IPC and retains typed migration failures", async () => {
  const pathname = createSource("CREATE TABLE probe(value TEXT); PRAGMA user_version = 1;");
  const before = fs.readFileSync(pathname);
  await using reader = createAgentSchemaInspectionWorker();
  const inspection = await reader.inspect({
    pathname,
    supportedVersion: 21,
    // Windows config environments are Proxies, which advanced IPC cannot clone.
    env: new Proxy({ OPENCLAW_STATE_DIR: path.dirname(pathname) }, {}),
    requireStartupMigrationReadiness: true,
  });
  expect(inspection?.version).toBe(1);
  expect(inspection?.failure).toBeInstanceOf(OpenClawAgentDatabaseMediaMigrationRequiredError);
  expect(inspection?.failure).toMatchObject({
    kind: "agent-media",
    pathname,
    schemaVersion: 1,
  });
  expect(fs.readFileSync(pathname)).toEqual(before);
});

it.each(["before launch", "during read"])(
  "settles canceled ownership %s after joining its schema reader",
  async (phase) => {
    const pathname = path.join(tempDirs.make("agent-schema-cancellation-"), "source.sqlite");
    fs.writeFileSync(pathname, "");
    const controller = new AbortController();
    const reason = new Error("preflight ownership stopped");
    vi.mocked(fork).mockClear();
    if (phase === "before launch") {
      controller.abort(reason);
    }
    await using reader = createAgentSchemaInspectionWorker();
    const operation = reader.inspect({ pathname, supportedVersion: 1 }, controller.signal);
    if (phase === "before launch") {
      await expect(operation).rejects.toBe(reason);
      expect(fork).not.toHaveBeenCalled();
      return;
    }
    const { child, closed } = observeChild();
    expect(child?.pid).toBeGreaterThan(0);
    const rejected = expect(operation).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(closed).toHaveBeenCalledOnce();
  },
);
