import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqlite from "../infra/node-sqlite.js";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "./openclaw-agent-db-migration-required.js";
import { createAgentSchemaInspectionWorker } from "./openclaw-agent-schema-inspection-worker.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: vi.fn(actual.fork) };
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("inspects state in cold children without executing comparison DDL", async () => {
  const directory = tempDirs.make("state-schema-contract-transfer-");
  const pathname = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: directory } }).path;
  closeOpenClawStateDatabaseForTest();
  const ddlLog = path.join(directory, "comparison-ddl.log");
  const preload = path.join(directory, "observe-comparison-ddl.cjs");
  fs.writeFileSync(ddlLog, "");
  fs.writeFileSync(
    preload,
    `const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
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
          purpose: "runtime",
          scope: "state",
        },
        undefined,
        pathname,
      );
      if (!result) {
        throw new Error("Expected the supplied snapshot to be inspectable");
      }
      expect(result.schemas).toEqual({ incompatible: [], indeterminate: [] });
      expect(fs.readFileSync(ddlLog, "utf8")).toBe("");
    }
  });
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "agentSchemaInspection child names a native snapshot-open refusal and reuses a healthy replacement",
  async () => {
    const directory = tempDirs.make("agent-schema-snapshot-open-");
    const pathname = path.join(directory, "source.sqlite");
    const snapshot = path.join(directory, "snapshot.sqlite");
    const database = sqlite.openNodeSqliteDatabase(pathname);
    database.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('unchanged');");
    database.close();
    fs.copyFileSync(pathname, snapshot);
    const before = fs.readFileSync(pathname);
    const identity = fs.statSync(snapshot, { bigint: true });
    try {
      await using reader = createAgentSchemaInspectionWorker();
      fs.chmodSync(snapshot, 0);
      const inspection = reader.inspect({ pathname, supportedVersion: 21 }, undefined, snapshot);
      const refusedChild = vi.mocked(fork).mock.results.at(-1)?.value;
      let refusedChildClosed = false;
      refusedChild.once("close", () => {
        refusedChildClosed = true;
      });
      const failure = await inspection.catch((error: unknown) => error);
      expect(failure).toMatchObject({
        name: "Error",
        code: "ERR_SQLITE_ERROR",
        errcode: 14,
      });
      expect(refusedChildClosed).toBe(true);
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
      expect(reader.processCount).toBe(2);
      expect(reader.inspectionCount).toBe(2);
      expect(reader.snapshotCount).toBe(2);
      for (const location of [pathname, snapshot]) {
        const source = sqlite.openNodeSqliteDatabase(location, { readOnly: true });
        try {
          expect(source.prepare("SELECT value FROM probe").get()).toEqual({ value: "unchanged" });
          expect(source.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        } finally {
          source.close();
        }
        expect(fs.readFileSync(location)).toEqual(before);
      }
      expect(failure).toHaveProperty(
        "message",
        "failed while creating its private snapshot: unable to open database file (code=ERR_SQLITE_ERROR, errcode=14)",
      );
    } finally {
      fs.chmodSync(snapshot, 0o600);
    }
  },
);

it("agentSchemaInspection carries a Proxy env across IPC and retains typed migration failures", async () => {
  const pathname = path.join(tempDirs.make("agent-schema-migration-"), "source.sqlite");
  const database = sqlite.openNodeSqliteDatabase(pathname);
  database.exec("CREATE TABLE probe(value TEXT); PRAGMA user_version = 1;");
  database.close();
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
    message: new OpenClawAgentDatabaseMediaMigrationRequiredError(pathname, 1).message,
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
    const child = vi.mocked(fork).mock.results.at(-1)?.value;
    expect(child?.pid).toBeGreaterThan(0);
    let closed = false;
    child.once("close", () => {
      closed = true;
    });
    const rejected = expect(operation).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(closed).toBe(true);
  },
);
