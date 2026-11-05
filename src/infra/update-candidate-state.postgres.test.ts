import "../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectBytesEqual } from "../../test/helpers/file-snapshots.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { checkTargetDatabaseSchemasForContexts as checkSchemas } from "../cli/update-cli/schema-preflight.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readBackupEngine } from "../snapshot/database-backup.js";
import { withArtifactPreservingStateReads as preserveArtifacts } from "../state/artifact-preserving-state-reads.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION as AGENT_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION as STATE_VERSION } from "../state/openclaw-state-db-contract.js";
import { agentPortProvider } from "./database-engine/agent-port.js";
import { writePortAnchor } from "./database-engine/port-backup.test-support.js";
import { materializeDatabasePort } from "./database-engine/port.worker.js";
import { statePortProvider } from "./database-engine/state-port.js";
import { ignoreMissingPath } from "./errno.js";
import { openNodeSqliteDatabase as openDatabase } from "./node-sqlite.js";
import {
  prepareSqliteDatabaseCleanClose,
  recordSqliteDatabaseIntegrity,
} from "./sqlite-database-admission.js";
import { admitSqliteSchema } from "./sqlite-schema-facts.js";
import { readUpdateStateSchemaVersions as readVersions } from "./update-candidate-state.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterAll);
const choices = [
  "sqlite-state",
  "postgres-state",
  "postgres-agents",
  "retained-postgres-agent",
  "retained-sqlite-agent",
] as const;
const schemaVersions = { state: STATE_VERSION, agent: AGENT_VERSION };
type Fixture = { stateDir: string; shared: string; agent: string; config: OpenClawConfig };
const contextFor = ({ stateDir, config }: Fixture) => ({
  config,
  env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
});
const inspect = (fixture: Fixture) =>
  readVersions({
    ...fixture,
    ...contextFor(fixture),
    additionalPaths: [],
    preserveSourceArtifacts: true,
  });
const admit = (fixture: Fixture, versions = schemaVersions) =>
  preserveArtifacts(() => checkSchemas(versions, [contextFor(fixture)]));

async function readArtifacts(files: string[]) {
  return Promise.all(
    files.map((file) =>
      Promise.all(
        ["", "-wal", "-shm"].map(
          async (suffix) =>
            [suffix, await fs.readFile(file + suffix).catch(ignoreMissingPath)] as const,
        ),
      ),
    ),
  );
}

function expectArtifactsEqual(
  actual: Awaited<ReturnType<typeof readArtifacts>>,
  expected: Awaited<ReturnType<typeof readArtifacts>>,
) {
  const shape = (artifacts: typeof actual) =>
    artifacts.map((file) => file.map(([suffix, bytes]) => [suffix, bytes !== undefined]));
  expect(shape(actual), "artifact order and presence").toEqual(shape(expected));
  actual.forEach((file, fileIndex) => {
    file.forEach(([suffix, bytes], suffixIndex) => {
      const expectedBytes = expected[fileIndex]![suffixIndex]![1];
      if (bytes !== undefined && expectedBytes !== undefined) {
        expectBytesEqual(bytes, expectedBytes, `artifact ${fileIndex}${suffix}`);
      }
    });
  });
}

describe.skipIf(!connection)("mixed-engine update inventory", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  let walAgent: ReturnType<typeof openDatabase> | undefined;
  const fixtures = new Map<string, Fixture>();
  beforeAll(async () => {
    await client.connect();
    const stateDescriptor = await statePortProvider.loadDescriptor();
    const agentDescriptor = await agentPortProvider.loadDescriptor();
    for (const choice of choices) {
      const stateDir = directories.make(`update-${choice}-`);
      const shared = path.join(stateDir, "state", "openclaw.sqlite");
      const agent = path.join(stateDir, "retained", "agent.sqlite");
      await fs.mkdir(path.dirname(shared));
      await fs.mkdir(path.dirname(agent));
      const defaultPg = choice === "retained-sqlite-agent";
      const statePg = choice === "postgres-state" || choice === "postgres-agents" || defaultPg;
      const agentPg = choice === "postgres-agents" || choice === "retained-postgres-agent";
      const config: OpenClawConfig = {
        database: {
          engine: defaultPg ? "postgres" : "sqlite",
          families: defaultPg
            ? undefined
            : {
                state: { engine: statePg ? "postgres" : "sqlite" },
                agent: { engine: choice === "postgres-agents" ? "postgres" : "sqlite" },
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
        using db = openDatabase(source);
        db.exec(descriptor.sqlite);
        for (const fragment of descriptor.fragments ?? []) {
          db.exec(fragment.sqlite);
        }
        if (file === shared) {
          db.exec(`PRAGMA user_version=${STATE_VERSION};
            INSERT INTO schema_meta VALUES ('primary','global',${STATE_VERSION},NULL,NULL,1,1);
            INSERT INTO config_machine_state VALUES ('state.schema.contentVersion','${STATE_VERSION}',1)`);
          db.prepare(
            "INSERT INTO agent_databases (agent_id,path,schema_version,last_seen_at) VALUES ('retained',?,?,1)",
          ).run(agent, AGENT_VERSION);
        } else {
          db.exec(`PRAGMA user_version=${AGENT_VERSION};
            INSERT INTO schema_meta VALUES ('primary','agent',${AGENT_VERSION},'retained',NULL,1,1)`);
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
          writePortAnchor(file, storeId, namespace, true);
          using anchor = openDatabase(file);
          admitSqliteSchema(anchor);
          recordSqliteDatabaseIntegrity(anchor);
          using seal = prepareSqliteDatabaseCleanClose(anchor);
          anchor.close();
          expect(seal.publish()).toBe(true);
        }
      }
      if (choice === "retained-sqlite-agent") {
        walAgent = openDatabase(agent);
        walAgent.exec(
          "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE retained_wal_probe(value TEXT); INSERT INTO retained_wal_probe VALUES ('retained')",
        );
        expect((await fs.stat(`${agent}-wal`)).size).toBeGreaterThan(0);
      }
      fixtures.set(choice, { stateDir, shared, agent, config });
    }
  });
  afterAll(async () => {
    walAgent?.close();
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await client.end();
  });

  it.each(choices)("inspects and admits selected state and retained agents: %s", async (choice) => {
    const fixture = fixtures.get(choice)!;
    const files = [fixture.shared, fixture.agent];
    const before = await readArtifacts(files);
    const versions = await inspect(fixture);
    expect(versions.find((entry) => entry.path === fixture.shared)).toMatchObject({
      userVersion: STATE_VERSION,
      contentVersion: STATE_VERSION,
    });
    expect(versions.find((entry) => entry.path === fixture.agent)?.userVersion).toBe(AGENT_VERSION);
    expectArtifactsEqual(await readArtifacts(files), before);
    for (const kind of ["state", "agent"] as const) {
      const incompatible = [
        {
          kind,
          path: kind === "state" ? fixture.shared : fixture.agent,
          foundVersion: schemaVersions[kind],
          supportedVersion: schemaVersions[kind] - 1,
        },
      ];
      const result = await admit(fixture, { ...schemaVersions, [kind]: schemaVersions[kind] - 1 });
      expect(result).toMatchObject({ indeterminate: [], incompatible });
    }
    expect(await admit(fixture)).toMatchObject({ indeterminate: [], incompatible: [] });
    expectArtifactsEqual(await readArtifacts(files), before);
  });

  it.each([AGENT_VERSION - 1, AGENT_VERSION + 1])(
    "admits an older selected PostgreSQL agent and refuses a newer server version: %s",
    async (version) => {
      const fixture = fixtures.get("postgres-agents")!;
      const anchor = readBackupEngine(fixture.agent);
      if (anchor.engine !== "postgres") {
        throw new Error("Expected the retained PostgreSQL agent fixture");
      }
      const before = await fs.readFile(fixture.agent);
      const setVersion = (physicalVersion: number) =>
        client.query(
          `UPDATE "${anchor.namespace}".openclaw_schema_meta SET version = $1 WHERE store = 'agent'`,
          [physicalVersion],
        );
      await setVersion(version);
      try {
        const versions = await inspect(fixture);
        expect(versions.find((entry) => entry.path === fixture.agent)?.userVersion).toBe(version);
        const result = await admit(fixture);
        expect(result.indeterminate).toEqual([]);
        expect(result.incompatible).toHaveLength(version > AGENT_VERSION ? 1 : 0);
        expectBytesEqual(await fs.readFile(fixture.agent), before, "selected PostgreSQL anchor");
      } finally {
        await setVersion(AGENT_VERSION);
      }
    },
  );
});
