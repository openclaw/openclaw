import "../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { cliRecoveryEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import type { PortDescriptor } from "../infra/database-engine/port-descriptor.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  createDiagnosticStores,
  diagnosticOutput,
  inspectDiagnosticStores as inspect,
  diagnosticConfig,
  diagnosticPaths,
  matrixRoot,
  retainedAgentRoot,
  portDiagnosticStore,
} from "./doctor-database-diagnostics.test-support.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

async function snapshot(...args: Parameters<typeof diagnosticOutput>) {
  const output = await diagnosticOutput(...args);
  expect({ text: output.text }).toMatchSnapshot();
}

describe.skipIf(!connection)("Doctor physical PostgreSQL output", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  let sqliteRoot: string;
  let postgresRoot: string;
  let descriptors: Map<string, PortDescriptor>;

  function port(root: string, relative: string, family: string) {
    return portDiagnosticStore({
      file: path.join(root, relative),
      descriptor: descriptors.get(family)!,
      client,
      connection: connection!,
      namespaces,
    });
  }

  beforeAll(async () => {
    await client.connect();
    sqliteRoot = tempDirs.make("doctor-output-sqlite-");
    descriptors = await createDiagnosticStores(sqliteRoot);
    postgresRoot = tempDirs.make("doctor-output-postgres-");
    fs.cpSync(sqliteRoot, postgresRoot, { recursive: true });
    for (const [family, relative] of Object.entries(diagnosticPaths)) {
      await port(postgresRoot, relative, family);
    }
    await port(postgresRoot, matrixRoot, "state");
    await port(postgresRoot, retainedAgentRoot, "agent");
  });

  afterAll(async () => {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await client.end();
  });

  it("inspects a configured OpenAI profile after porting shared state and agent storage", async () => {
    const root = tempDirs.make("doctor-postgres-auth-");
    for (const relative of [diagnosticPaths.state, diagnosticPaths.agent]) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(path.join(sqliteRoot, relative), file);
    }
    {
      using db = openNodeSqliteDatabase(path.join(root, diagnosticPaths.state));
      const insert = db.prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)");
      insert.run("auth.sharedStore", JSON.stringify({ location: "state-db" }));
      insert.run(
        "authProfiles.store",
        JSON.stringify({
          version: 1,
          profiles: {
            "openai:default": {
              type: "oauth",
              provider: "openai",
              access: "synthetic-access",
              refresh: "synthetic-refresh",
              expires: 2e12,
            },
          },
        }),
      );
    }
    await port(root, diagnosticPaths.state, "state");
    await port(root, diagnosticPaths.agent, "agent");
    const configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...diagnosticConfig(connection),
        plugins: { allow: ["codex"], entries: { codex: { enabled: true } } },
        auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } },
      }),
    );
    const entry = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli);
    const checkId = "codex/native-profile-recovery";
    const report = await runCliProcessChild({
      nodeArgs: [
        ...resolveRuntimeWorkerArgv(entry),
        "doctor",
        "--lint",
        "--json",
        "--only",
        checkId,
      ],
      env: {
        PATH: process.env.PATH,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_HIDE_BANNER: "1",
      },
      timeoutMs: 60_000,
    });
    expect(JSON.parse(report.stdout), report.stderr).toMatchObject({ checksRun: 1, findings: [] });
    expect(report.code, report.stderr).toBe(0);
  }, 60_000);

  it("reports each PostgreSQL family and Matrix namespace while safety stores stay local", async () => {
    const stores = await inspect(postgresRoot, diagnosticConfig(connection));
    const physical = stores.filter((store) => store.observed === "postgres");
    // Snapshots retain every store field; namespace uniqueness is lost during normalization.
    for (const store of physical) {
      expect(store.namespace).toMatch(/^doctor_proof_/);
    }
    expect(new Set(physical.map((store) => store.namespace)).size).toBe(physical.length);
    await snapshot(
      postgresRoot,
      diagnosticConfig(connection),
      descriptors,
      stores,
      ["postgres"],
      connection,
    );
  });

  it.each(["state", "agent"] as const)(
    "reports mixed mode with only %s on PostgreSQL",
    async (postgresFamily) => {
      const root = tempDirs.make(`doctor-output-mixed-${postgresFamily}-`);
      fs.cpSync(sqliteRoot, root, { recursive: true });
      const relatives =
        postgresFamily === "state"
          ? [diagnosticPaths.state, matrixRoot]
          : [diagnosticPaths.agent, retainedAgentRoot];
      for (const relative of relatives) {
        fs.copyFileSync(path.join(postgresRoot, relative), path.join(root, relative));
      }
      const config = diagnosticConfig();
      config.database = {
        engine: "sqlite",
        families: { [postgresFamily]: { engine: "postgres" } },
        postgres: { connection },
      };
      const stores = await inspect(root, config);
      await snapshot(root, config, descriptors, stores, ["sqlite", postgresFamily], connection);
    },
  );

  it("preserves physical identity but reports unknown schema and ownership when PostgreSQL is unreachable", async () => {
    const unreachableConnection =
      "postgresql://synthetic-user:synthetic-password@127.0.0.1:1/unreachable";
    const config = diagnosticConfig(unreachableConnection);
    const stores = await inspect(postgresRoot, config);
    await snapshot(
      postgresRoot,
      config,
      descriptors,
      stores,
      ["postgres"],
      connection,
      unreachableConnection,
    );
  });

  it("reports keyword-only capability and the administrator grant when pgvector is missing", async () => {
    const database = `doctor_no_vector_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE DATABASE "${database}"`);
    const url = new URL(connection!);
    url.pathname = `/${database}`;
    const isolatedConnection = url.toString();
    const isolated = new Client({ connectionString: isolatedConnection });
    try {
      await isolated.connect();
      await isolated.query("CREATE EXTENSION unaccent; CREATE EXTENSION pg_trgm");
      const root = tempDirs.make("doctor-output-no-vector-");
      fs.cpSync(sqliteRoot, root, { recursive: true });
      await portDiagnosticStore({
        file: path.join(root, diagnosticPaths.agent),
        descriptor: descriptors.get("agent")!,
        client: isolated,
        connection: isolatedConnection,
        namespaces: new Set(),
      });
      const config = diagnosticConfig();
      config.database = {
        engine: "sqlite",
        families: { agent: { engine: "postgres" } },
        postgres: { connection: isolatedConnection },
      };
      const stores = await inspect(root, config);
      const agent = stores.find((store) => store.family === "agent")!;
      await snapshot(root, config, descriptors, agent, ["sqlite", "agent"], isolatedConnection);
    } finally {
      await isolated.end();
      await client.query(`DROP DATABASE "${database}"`);
    }
  });
});
