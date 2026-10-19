import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { AGENT_SCHEMA_COMPATIBILITY } from "../state/openclaw-agent-db-schema-compatibility.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("uses fingerprints in a cold worker and loads diagnostics only after schema drift, without comparison DDL", async () => {
  const pathname = path.join(tempDirs.make("schema-contract-worker-"), "agent.sqlite");
  const database = new DatabaseSync(pathname);
  database.exec(`PRAGMA journal_mode=WAL; ${OPENCLAW_AGENT_SCHEMA_SQL}`);
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const fs = require("node:fs");
    const { syncBuiltinESMExports } = require("node:module");
    let diagnosticCatalogReads = 0;
    const readFileSync = fs.readFileSync;
    fs.readFileSync = function(path, ...args) {
      if (/sqlite-(?:agent|state)-catalogs\\.json$/.test(String(path))) diagnosticCatalogReads++;
      return Reflect.apply(readFileSync, this, [path, ...args]);
    };
    syncBuiltinESMExports();
    let comparisonDdl = 0;
    for (const method of ["exec", "prepare"]) {
      const original = DatabaseSync.prototype[method];
      DatabaseSync.prototype[method] = function(sql) {
        if (this.location() === null && /\\b(?:CREATE|ALTER|DROP)\\b/i.test(sql)) comparisonDdl++;
        return Reflect.apply(original, this, [sql]);
      };
    }
    let database, contracts;
    parentPort.on("message", async () => {
      try {
        if (!contracts) {
          const { register } = await import(workerData.loader);
          register();
          contracts = await import(workerData.contracts);
          database = new DatabaseSync(workerData.pathname, { readOnly: true });
        }
        const issues = contracts.collectSqliteSchemaIssues(database, workerData.schemaSql, workerData.compatibility);
        parentPort.postMessage({ issues, comparisonDdl, diagnosticCatalogReads });
      } catch (error) {
        parentPort.postMessage({ error: error.message, comparisonDdl, diagnosticCatalogReads });
      }
    });
    `,
    {
      eval: true,
      execArgv: [],
      workerData: {
        pathname,
        schemaSql: OPENCLAW_AGENT_SCHEMA_SQL,
        compatibility: AGENT_SCHEMA_COMPATIBILITY,
        loader: import.meta.resolve("tsx/esm/api"),
        contracts: new URL("./sqlite-schema-contract.ts", import.meta.url).href,
      },
    },
  );
  let pending: ReturnType<typeof createDeferredCore<unknown>>;
  worker.on("message", (value) => pending.resolve(value));
  worker.on("error", (error) => pending.reject(error));
  const inspect = () => {
    pending = createDeferredCore<unknown>();
    worker.postMessage(undefined, []);
    return pending.promise;
  };
  try {
    await expect(inspect()).resolves.toEqual({
      issues: [],
      comparisonDdl: 0,
      diagnosticCatalogReads: 0,
    });
    database.exec("ALTER TABLE session_nodes ADD COLUMN foreign_column TEXT DEFAULT ''");
    await expect(inspect()).resolves.toEqual({
      issues: [
        {
          code: "unexpected-column",
          objectName: "session_nodes.foreign_column",
          message: "column definitions differ for session_nodes",
        },
      ],
      comparisonDdl: 0,
      diagnosticCatalogReads: 1,
    });
    database.exec("ALTER TABLE session_nodes DROP COLUMN foreign_column");
    await expect(inspect()).resolves.toEqual({
      issues: [],
      comparisonDdl: 0,
      diagnosticCatalogReads: 1,
    });
  } finally {
    await worker.terminate();
    database.close();
  }
});
