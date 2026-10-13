import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { prepareOpenClawDatabaseSchemaContracts } from "../state/openclaw-database-schema-contracts.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { getOpenClawStateRuntimeSchema } from "../state/openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import type { RuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import { getCanonicalSqliteTableNames } from "./sqlite-schema-contract.js";
import { captureRetainedNativeWorkerSource } from "./worker-native-lifecycle.js";
import type { RetainedNativeWorker } from "./worker-native-lifecycle.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const expectedContractsKey = "openclaw.sqliteExpectedSchemaContracts.v1";
// A distinct full schema keeps unrelated parent admission from warming this regression.
const schemaSql = `${OPENCLAW_AGENT_SCHEMA_SQL}
  CREATE TABLE schema_contract_inheritance (id INTEGER PRIMARY KEY);`;
const nextSchemaSql = `${schemaSql}
  ALTER TABLE schema_contract_inheritance ADD COLUMN next_version TEXT;`;

it("inherits complete expected schemas through a cold carrier while rechecking actual databases", async () => {
  const directory = tempDirs.make("schema-contract-worker-");
  const pathname = path.join(directory, "agent.sqlite");
  const statePath = path.join(directory, "state.sqlite");
  const runtimeStateSchema = getOpenClawStateRuntimeSchema({
    includeVersionLazyAdditiveTables: false,
  });
  const originalFacts = getEnvironmentData(expectedContractsKey);
  let closeSource: Parameters<RuntimeWorkerGeneration["retain"]>[1] | undefined;
  const source = captureRetainedNativeWorkerSource({
    runtimeGeneration: {
      resolve: (url) => url,
      retain: (_owner, close) => {
        closeSource = close;
      },
    },
  });
  const children: RetainedNativeWorker[] = [];
  source.retain({}, async () => {
    await Promise.all(children.map((child) => child.terminate()));
  });
  const spawn = () => {
    const worker = source.create(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync, StatementSync } = require("node:sqlite");
      const comparisons = new Set(), statements = new WeakMap();
      let expectedStatements = 0, actualCatalogReads = 0;
      const originalExec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) {
        if ([workerData.schemaSql, workerData.nextSchemaSql, workerData.agentSchemaSql, workerData.stateSchemaSql, workerData.runtimeStateSchema].includes(sql)) {
          comparisons.add(this);
        }
        if (comparisons.has(this)) expectedStatements++;
        return Reflect.apply(originalExec, this, [sql]);
      };
      const originalPrepare = DatabaseSync.prototype.prepare;
      DatabaseSync.prototype.prepare = function(sql) {
        const statement = Reflect.apply(originalPrepare, this, [sql]);
        statements.set(statement, this);
        return statement;
      };
      for (const method of ["get", "all", "run", "iterate"]) {
        const original = StatementSync.prototype[method];
        StatementSync.prototype[method] = function(...args) {
          const owner = statements.get(this);
          if (comparisons.has(owner)) expectedStatements++;
          if ((owner === database || owner === stateDatabase) && this.sourceSQL.includes("FROM main.sqlite_schema")) {
            actualCatalogReads++;
          }
          return Reflect.apply(original, this, args);
        };
      }
      let database, stateDatabase, contracts;
      parentPort.on("message", async (command) => {
        if (command.kind === "ping") {
          parentPort.postMessage({ ready: true });
          return;
        }
        expectedStatements = actualCatalogReads = 0;
        let error, issues, found;
        try {
          if (!database) {
            const { register } = await import(workerData.loader);
            register();
            contracts = await import(workerData.contracts);
            database = new DatabaseSync(workerData.pathname, { readOnly: true });
          }
          if (command.kind === "inspect-state") {
            stateDatabase ??= new DatabaseSync(workerData.statePath, { readOnly: true });
            const { assertCurrentStateRuntimeSchema } = await import(workerData.stateAdmission);
            const { inspectCurrentStateStartupSchema } = await import(workerData.stateInspection);
            assertCurrentStateRuntimeSchema(stateDatabase, workerData.statePath);
            issues = inspectCurrentStateStartupSchema(stateDatabase, workerData.statePath, workerData.stateVersion);
          } else if (command.kind === "open-agent") {
            const { openOpenClawAgentDatabaseReadOnly } = await import(workerData.agentReader);
            const opened = openOpenClawAgentDatabaseReadOnly({
              agentId: "main", path: workerData.pathname, env: workerData.environment,
            });
            found = opened.found;
            if (opened.found) opened.database.close();
          } else {
            issues = contracts.collectSqliteSchemaIssues(
              database, command.kind === "next-schema" ? workerData.nextSchemaSql : workerData.schemaSql,
            );
          }
        } catch (caught) {
          error = caught.message;
        }
        parentPort.postMessage({ error, issues, found, expectedStatements, actualCatalogRead: actualCatalogReads > 0 });
      });
    `,
      {
        eval: true,
        execArgv: [],
        workerData: {
          pathname,
          schemaSql,
          nextSchemaSql,
          agentSchemaSql: OPENCLAW_AGENT_SCHEMA_SQL,
          statePath,
          stateVersion: OPENCLAW_STATE_SCHEMA_VERSION,
          stateSchemaSql: OPENCLAW_STATE_SCHEMA_SQL,
          runtimeStateSchema,
          environment: { OPENCLAW_STATE_DIR: directory },
          loader: import.meta.resolve("tsx/esm/api"),
          contracts: new URL("./sqlite-schema-contract.ts", import.meta.url).href,
          agentReader: new URL("../state/openclaw-agent-db-readonly-open.ts", import.meta.url).href,
          stateAdmission: new URL("../state/openclaw-state-db-fast-path.ts", import.meta.url).href,
          stateInspection: new URL("../state/openclaw-state-schema-inspection.ts", import.meta.url)
            .href,
        },
      },
    );
    children.push(worker);
    let pending: ReturnType<typeof createDeferredCore<unknown>>;
    worker.on("message", (value) => pending.resolve(value));
    worker.on("error", (error) => pending.reject(error));
    return (kind = "inspect") => {
      pending = createDeferredCore<unknown>();
      worker.postMessage({ kind }, []);
      return pending.promise;
    };
  };
  const database = new DatabaseSync(pathname);
  const stateDatabase = new DatabaseSync(statePath);
  try {
    database.exec(`PRAGMA journal_mode=WAL; ${schemaSql}`);
    database.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION};
      INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
      VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', 1, 1);`);
    stateDatabase.exec(`PRAGMA journal_mode=WAL; ${runtimeStateSchema}`);
    stateDatabase.exec(`PRAGMA user_version=${OPENCLAW_STATE_SCHEMA_VERSION};
      INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
      VALUES ('primary', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, 1, 1);`);
    setEnvironmentData(expectedContractsKey, undefined);
    const beforeWarming = spawn();
    await expect(beforeWarming("ping")).resolves.toEqual({ ready: true });

    const construction = vi.spyOn(DatabaseSync.prototype, "exec");
    try {
      expect(getCanonicalSqliteTableNames(schemaSql)).toContain("schema_contract_inheritance");
      expect(getCanonicalSqliteTableNames(schemaSql)).toContain("session_nodes");
      prepareOpenClawDatabaseSchemaContracts();
      prepareOpenClawDatabaseSchemaContracts();
      expect(construction.mock.calls.filter(([sql]) => sql === schemaSql)).toHaveLength(1);
      for (const schema of [OPENCLAW_AGENT_SCHEMA_SQL, OPENCLAW_STATE_SCHEMA_SQL]) {
        expect(construction.mock.calls.filter(([sql]) => sql === schema)).toHaveLength(1);
      }
    } finally {
      construction.mockRestore();
    }
    const admittedFacts = getEnvironmentData(expectedContractsKey);
    const inspect = spawn();
    await expect(inspect("inspect-state")).resolves.toMatchObject({
      error: undefined,
      issues: { blockingIssues: [], startupRepairableIssues: [] },
      expectedStatements: 0,
      actualCatalogRead: true,
    });
    stateDatabase.exec(
      "ALTER TABLE config_machine_state ADD COLUMN foreign_column TEXT NOT NULL DEFAULT ''",
    );
    await expect(inspect("inspect-state")).resolves.toMatchObject({
      error: expect.stringMatching(/column definitions differ for config_machine_state/u),
      expectedStatements: 0,
      actualCatalogRead: true,
    });
    stateDatabase.exec("ALTER TABLE config_machine_state DROP COLUMN foreign_column");
    await expect(inspect()).resolves.toMatchObject({
      error: undefined,
      issues: [],
      expectedStatements: 0,
      actualCatalogRead: true,
    });

    database.exec("ALTER TABLE schema_contract_inheritance ADD COLUMN foreign_column TEXT");
    await expect(inspect()).resolves.toMatchObject({
      error: undefined,
      issues: [
        { code: "unexpected-column", objectName: "schema_contract_inheritance.foreign_column" },
      ],
      expectedStatements: 0,
      actualCatalogRead: true,
    });
    database.exec("ALTER TABLE schema_contract_inheritance DROP COLUMN foreign_column");

    const next = await inspect("next-schema");
    expect(next).toMatchObject({
      error: undefined,
      issues: [{ code: "missing-column", objectName: "schema_contract_inheritance.next_version" }],
      actualCatalogRead: true,
    });
    assert(next && typeof next === "object" && "expectedStatements" in next);
    expect(next.expectedStatements).toBeGreaterThan(0);

    const missing = await beforeWarming();
    expect(missing).toMatchObject({ error: undefined, issues: [], actualCatalogRead: true });
    assert(missing && typeof missing === "object" && "expectedStatements" in missing);
    expect(missing.expectedStatements).toBeGreaterThan(0);

    assert(admittedFacts && typeof admittedFacts === "object" && "runtime" in admittedFacts);
    assert(admittedFacts.runtime && typeof admittedFacts.runtime === "object");
    setEnvironmentData(expectedContractsKey, {
      ...admittedFacts,
      runtime: { ...admittedFacts.runtime, nodeVersion: "another runtime" },
    });
    const incompatible = await spawn()();
    expect(incompatible).toMatchObject({ error: undefined, issues: [], actualCatalogRead: true });
    assert(
      incompatible && typeof incompatible === "object" && "expectedStatements" in incompatible,
    );
    expect(incompatible.expectedStatements).toBeGreaterThan(0);

    await expect(inspect("open-agent")).resolves.toMatchObject({
      error: undefined,
      found: true,
      expectedStatements: 0,
    });
    setEnvironmentData(expectedContractsKey, admittedFacts);
    await expect(spawn()("open-agent")).resolves.toMatchObject({
      error: undefined,
      found: true,
      expectedStatements: 0,
    });
    database.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1};
      UPDATE schema_meta SET schema_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
    await expect(inspect("open-agent")).resolves.toMatchObject({
      error: expect.stringMatching(/newer|newest supported/u),
      found: undefined,
      expectedStatements: 0,
    });
  } finally {
    database.close();
    stateDatabase.close();
    setEnvironmentData(expectedContractsKey, originalFacts);
    const retire = await closeSource?.();
    if (retire) {
      await retire();
    }
  }
});
