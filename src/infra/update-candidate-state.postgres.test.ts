import "../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { checkTargetDatabaseSchemasForContexts } from "../cli/update-cli/schema-preflight.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readBackupEngine } from "../snapshot/database-backup.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { agentPortProvider } from "./database-engine/agent-port.js";
import { materializeDatabasePort } from "./database-engine/port.worker.js";
import { statePortProvider } from "./database-engine/state-port.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { readUpdateStateSchemaVersions } from "./update-candidate-state.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!connection)("mixed-engine update inventory", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  const fixtures = new Map<
    string,
    { stateDir: string; shared: string; agent: string; config: OpenClawConfig }
  >();
  beforeAll(async () => {
    await client.connect();
    const stateDescriptor = await statePortProvider.loadDescriptor();
    const agentDescriptor = await agentPortProvider.loadDescriptor();
    for (const choice of [
      "sqlite-state",
      "postgres-state",
      "postgres-agents",
      "retained-postgres-agent",
    ] as const) {
      const stateDir = directories.make(`update-${choice}-`);
      const shared = path.join(stateDir, "state", "openclaw.sqlite");
      const agent = path.join(stateDir, "retained", "agent.sqlite");
      await fs.mkdir(path.dirname(shared));
      await fs.mkdir(path.dirname(agent));
      const statePg = choice === "postgres-state" || choice === "postgres-agents";
      const agentPg = choice === "postgres-agents" || choice === "retained-postgres-agent";
      const config: OpenClawConfig = {
        database: {
          engine: choice === "postgres-agents" ? "postgres" : "sqlite",
          families:
            choice === "postgres-agents"
              ? undefined
              : {
                  state: { engine: statePg ? "postgres" : "sqlite" },
                  workboard: { engine: "postgres" },
                },
          postgres: { connection: connection! },
        },
      };
      for (const [file, descriptor, postgres] of [
        [shared, stateDescriptor, statePg],
        [agent, agentDescriptor, agentPg],
      ] as const) {
        const source = postgres ? `${file}.source` : file;
        using db = openNodeSqliteDatabase(source);
        db.exec(descriptor.sqlite);
        if (file === shared) {
          db.exec(`PRAGMA user_version=${OPENCLAW_STATE_SCHEMA_VERSION};
            INSERT INTO schema_meta VALUES ('primary','global',${OPENCLAW_STATE_SCHEMA_VERSION},NULL,NULL,1,1);
            INSERT INTO config_machine_state VALUES ('state.schema.contentVersion','${OPENCLAW_STATE_SCHEMA_VERSION}',1)`);
          db.prepare(
            "INSERT INTO agent_databases (agent_id,path,schema_version,last_seen_at) VALUES ('retained',?,?,1)",
          ).run(agent, OPENCLAW_AGENT_SCHEMA_VERSION);
        } else {
          db.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION};
            INSERT INTO schema_meta VALUES ('primary','agent',${OPENCLAW_AGENT_SCHEMA_VERSION},'retained',NULL,1,1)`);
        }
        if (postgres) {
          const storeId = randomUUID();
          const namespace = `update_family_${storeId.replaceAll("-", "")}`;
          namespaces.add(namespace);
          await materializeDatabasePort({
            source: { engine: "sqlite", db },
            destination: { engine: "postgres", db: client, namespace },
            descriptor,
            storeId,
            assertCurrent() {},
          });
          using anchor = openNodeSqliteDatabase(file);
          anchor.exec(
            "CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)",
          );
          anchor
            .prepare("INSERT INTO openclaw_engine_anchor VALUES (?,'postgres',?)")
            .run(storeId, namespace);
        }
      }
      fixtures.set(choice, { stateDir, shared, agent, config });
    }
  });
  afterAll(async () => {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await client.end();
  });

  it.each(["sqlite-state", "postgres-state", "postgres-agents", "retained-postgres-agent"])(
    "inspects selected state and physical retained agents: %s",
    async (choice) => {
      const fixture = fixtures.get(choice)!;
      const files = [fixture.shared, fixture.agent];
      const before = await Promise.all(files.map((file) => fs.readFile(file)));
      const versions = await readUpdateStateSchemaVersions({
        ...fixture,
        env: { ...process.env, OPENCLAW_STATE_DIR: fixture.stateDir },
        additionalPaths: [],
        preserveSourceArtifacts: true,
      });
      expect(versions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: fixture.shared,
            userVersion: OPENCLAW_STATE_SCHEMA_VERSION,
            contentVersion: OPENCLAW_STATE_SCHEMA_VERSION,
          }),
          { path: fixture.agent, userVersion: OPENCLAW_AGENT_SCHEMA_VERSION },
        ]),
      );
      expect(await Promise.all(files.map((file) => fs.readFile(file)))).toEqual(before);
    },
  );

  it.each(["sqlite-state", "postgres-state", "postgres-agents", "retained-postgres-agent"])(
    "public update admission inspects the selected state and physical agent: %s",
    async (choice) => {
      const fixture = fixtures.get(choice)!;
      const before = await Promise.all(
        [fixture.shared, fixture.agent].map((file) => fs.readFile(file)),
      );
      const result = await checkTargetDatabaseSchemasForContexts(
        { state: OPENCLAW_STATE_SCHEMA_VERSION, agent: OPENCLAW_AGENT_SCHEMA_VERSION - 1 },
        [{ config: fixture.config, env: { ...process.env, OPENCLAW_STATE_DIR: fixture.stateDir } }],
      );
      expect(result.indeterminate).toEqual([]);
      expect(result.incompatible).toEqual([
        expect.objectContaining({
          kind: "agent",
          path: fixture.agent,
          foundVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
          supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION - 1,
        }),
      ]);
      expect(
        await Promise.all([fixture.shared, fixture.agent].map((file) => fs.readFile(file))),
      ).toEqual(before);
    },
  );

  it.each([OPENCLAW_AGENT_SCHEMA_VERSION - 1, OPENCLAW_AGENT_SCHEMA_VERSION + 1])(
    "reports a retained PostgreSQL agent's physical version %s instead of the descriptor version",
    async (version) => {
      const fixture = fixtures.get("postgres-agents")!;
      const anchor = readBackupEngine(fixture.agent);
      if (anchor.engine !== "postgres") {
        throw new Error("Expected the retained PostgreSQL agent fixture");
      }
      const before = await fs.readFile(fixture.agent);
      await client.query(
        `UPDATE "${anchor.namespace}".openclaw_schema_meta SET version = $1 WHERE store = 'agent'`,
        [version],
      );
      try {
        const versions = await readUpdateStateSchemaVersions({
          ...fixture,
          env: { ...process.env, OPENCLAW_STATE_DIR: fixture.stateDir },
          additionalPaths: [],
          preserveSourceArtifacts: true,
        });
        expect(versions.find((entry) => entry.path === fixture.agent)).toEqual({
          path: fixture.agent,
          userVersion: version,
        });
        expect(await fs.readFile(fixture.agent)).toEqual(before);
      } finally {
        await client.query(
          `UPDATE "${anchor.namespace}".openclaw_schema_meta SET version = $1 WHERE store = 'agent'`,
          [OPENCLAW_AGENT_SCHEMA_VERSION],
        );
      }
    },
  );
});
