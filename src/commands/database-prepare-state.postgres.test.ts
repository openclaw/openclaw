import "../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Command } from "commander";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerDatabaseCommand } from "../cli/program/register.database.js";
import { installDatabaseProcessRole } from "../infra/database-engine/admission-scope.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const roots = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!connection)("database prepare-state against PostgreSQL", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  beforeAll(async () => {
    installDatabaseProcessRole("cli-oneshot");
    await client.connect();
  });
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetDatabaseEngineSelectionForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await client.end();
  });

  function fixture() {
    const root = roots.make("prepare-state-");
    const stateDir = path.join(root, "state");
    const pathname = path.join(stateDir, "state", "openclaw.sqlite");
    const storeId = randomUUID();
    const namespace = `prepare_state_${storeId.replaceAll("-", "").slice(0, 16)}`;
    namespaces.add(namespace);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    using db = openNodeSqliteDatabase(pathname);
    db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
    db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(
      storeId,
      namespace,
    );
    const configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        database: { engine: "postgres", postgres: { connection, schemaPrefix: "prepare" } },
      }),
    );
    vi.stubEnv("OPENCLAW_HOME", root);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    return { root, pathname, storeId, namespace };
  }

  async function run(storeId: string, namespace: string, code = 0) {
    const output: string[] = [];
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
      output.push(JSON.stringify(value));
    });
    vi.spyOn(defaultRuntime, "exit").mockImplementation((status) => {
      throw new ExitError(status);
    });
    const program = new Command().exitOverride();
    registerDatabaseCommand(program);
    const invocation = program.parseAsync(
      [
        "database",
        "prepare-state",
        "--expected-store-id",
        storeId,
        "--expected-namespace",
        namespace,
        "--json",
      ],
      { from: "user" },
    );
    if (code === 0) {
      await expect(invocation, output.join("\n")).resolves.toBe(program);
    } else {
      await expect(invocation).rejects.toMatchObject({ code });
    }
    return JSON.parse(output.join(""));
  }

  it("prepares only the exact absent namespace and validates a repeat without changing anchor or stored data", async () => {
    const { pathname, storeId, namespace } = fixture();
    const anchor = fs.readFileSync(pathname);
    expect(await run(storeId, namespace)).toMatchObject({
      ok: true,
      status: "prepared",
      schemaVersion: 40,
      storeId,
      namespace,
    });
    await client.query(
      `INSERT INTO "${namespace}".config_machine_state VALUES ('prepare.proof', 'true', 1)`,
    );
    const metadata = (await client.query(`SELECT * FROM "${namespace}".openclaw_schema_meta`)).rows;
    expect(await run(storeId, namespace)).toMatchObject({
      ok: true,
      status: "ready",
      schemaVersion: 40,
    });
    expect(
      (
        await client.query(
          `SELECT value_json FROM "${namespace}".config_machine_state WHERE state_key = 'prepare.proof'`,
        )
      ).rows,
    ).toEqual([{ value_json: "true" }]);
    expect((await client.query(`SELECT * FROM "${namespace}".openclaw_schema_meta`)).rows).toEqual(
      metadata,
    );
    expect(fs.readFileSync(pathname)).toEqual(anchor);
  });

  it("refuses a mismatched anchor and an incomplete existing namespace without bootstrap", async () => {
    const { pathname, storeId, namespace } = fixture();
    const anchor = fs.readFileSync(pathname);
    const wrongId = randomUUID();
    const wrongNamespace = `prepare_state_${wrongId.replaceAll("-", "").slice(0, 16)}`;
    expect(await run(wrongId, wrongNamespace, 1)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("anchor does not match") },
    });
    expect(
      (await client.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [wrongNamespace])).rows,
    ).toEqual([]);
    await client.query(
      `CREATE SCHEMA "${namespace}"; CREATE TABLE "${namespace}".sentinel (value text); INSERT INTO "${namespace}".sentinel VALUES ('preserve')`,
    );
    expect(await run(storeId, namespace, 1)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Missing PostgreSQL metadata") },
    });
    expect(
      (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = $1", [namespace]))
        .rows,
    ).toEqual([{ tablename: "sentinel" }]);
    expect((await client.query(`SELECT * FROM "${namespace}".sentinel`)).rows).toEqual([
      { value: "preserve" },
    ]);
    expect(fs.readFileSync(pathname)).toEqual(anchor);
  });

  it("refuses current-version catalog drift and wrong store metadata without repairing either", async () => {
    const { storeId, namespace } = fixture();
    await run(storeId, namespace);
    await client.query(
      `ALTER TABLE "${namespace}".config_machine_state ADD COLUMN unexpected text`,
    );
    expect(await run(storeId, namespace, 1)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("schema drift") },
    });
    await client.query(`UPDATE "${namespace}".openclaw_schema_meta SET store_id = 'wrong-store'`);
    expect(await run(storeId, namespace, 1)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("identity mismatch") },
    });
    expect(
      (await client.query(`SELECT store_id FROM "${namespace}".openclaw_schema_meta`)).rows,
    ).toEqual([{ store_id: "wrong-store" }]);
    expect(
      (
        await client.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'unexpected'",
          [namespace],
        )
      ).rows,
    ).toHaveLength(1);
  });
});
