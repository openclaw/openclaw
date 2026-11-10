import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { expect, it, vi } from "vitest";
import "./backup-worker.test-support.js";
import { backupDoctorPostgresMigration } from "../../commands/doctor-postgres-migration.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  capturePostgresSchema,
  pruneOrphanedPostgresCaptures,
} from "../../snapshot/database-backup-core.worker.js";
import {
  capturePostgresBackup,
  discardPostgresSchemaCaptures,
  preparePostgresRestore,
  prunePostgresSchemaCaptures,
  readBackupEngine,
  verifyMatchedPostgresBackup,
} from "../../snapshot/database-backup.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { agentPortProvider } from "./agent-port.js";
import { createUpdateDatabaseBackupWithFixtureTransport } from "./backup-capture.test-support.js";
import { workboardPortFixture, writePortAnchor } from "./port-backup.test-support.js";
import { admitDatabasePortDescriptor } from "./port-descriptor.js";
import { inspectDatabasePort, materializeDatabasePort } from "./port.worker.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;

type Seeded = {
  state: Parameters<Parameters<typeof withOpenClawTestState>[1]>[0];
  client: Client;
  namespace: string;
  namespaces: Set<string>;
  storeId: string;
  anchorPath: string;
  config: OpenClawConfig;
  descriptor: Awaited<ReturnType<typeof workboardPortFixture>>["descriptor"];
};

const schemaExists = async (client: Client, schema: string) =>
  (await client.query("SELECT to_regnamespace($1) IS NOT NULL AS present", [schema])).rows[0]
    .present as boolean;

/** A PostgreSQL workboard store with a SQLite state family, as on a mixed install. */
async function withSeededWorkboard(run: (seeded: Seeded) => Promise<void>) {
  assert(connection);
  await withOpenClawTestState({ scenario: "minimal", prefix: "pg-schema-" }, async (state) => {
    const client = new Client({ connectionString: connection });
    const namespace = `backup_${randomUUID().replaceAll("-", "")}`;
    const namespaces = new Set([namespace]);
    const storeId = randomUUID();
    const anchorPath = state.statePath("plugins", "workboard", "workboard.sqlite");
    const config: OpenClawConfig = {
      database: { families: { workboard: { engine: "postgres" } }, postgres: { connection } },
      plugins: { entries: { workboard: { enabled: true } } },
    };
    await state.writeConfig(config);
    await fs.mkdir(path.dirname(anchorPath), { recursive: true });
    await client.connect();
    try {
      const { descriptor } = await workboardPortFixture();
      {
        using source = openNodeSqliteDatabase(":memory:", { readBigInts: true });
        source.exec(descriptor.sqlite);
        source.exec(`
          INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES ('board', '', 1, 1);
          INSERT INTO workboard_cards (id, board_id, title, status, priority, position, created_at, updated_at)
          VALUES ('card', 'board', 'Captured', 'todo', 'normal', 0.5, 1, 1);
          INSERT INTO workboard_card_notifications (id, card_id, ordinal, kind, message, created_at, sequence)
          VALUES ('notification', 'card', 1, 'status', 'synthetic', 3, 9007199254740995);
        `);
        await materializeDatabasePort({
          source: { engine: "sqlite", db: source },
          destination: { engine: "postgres", db: client, namespace },
          descriptor,
          storeId,
          assertCurrent() {},
        });
      }
      writePortAnchor(anchorPath, storeId, namespace, true);
      openOpenClawStateDatabase({ env: state.env });
      await closeOpenClawStateDatabaseAsync();
      await run({ state, client, namespace, namespaces, storeId, anchorPath, config, descriptor });
    } finally {
      await closeOpenClawStateDatabaseAsync();
      for (const owned of namespaces) {
        await client.query(`DROP SCHEMA IF EXISTS "${owned}" CASCADE`);
      }
      await client.end();
    }
  });
}

it.skipIf(!connection)(
  "keeps exact update captures in a frozen PostgreSQL schema that rollback copies and retirement drops",
  () =>
    withSeededWorkboard(
      async ({ state, client, namespace, namespaces, storeId, anchorPath, config, descriptor }) => {
        const titles = async (ns: string) =>
          (await client.query(`SELECT title FROM "${ns}".workboard_cards`)).rows;
        const backup = await createUpdateDatabaseBackupWithFixtureTransport({
          backupRoot: state.path("update"),
          stateDir: state.stateDir,
          config,
          env: state.env,
          stopped: true,
          postgresSchemaCaptures: true,
        });
        // The SQLite state family keeps its ordinary image beside the PostgreSQL capture.
        const shared = backup.databases.find(
          (item) => item.path === state.statePath("state", "openclaw.sqlite"),
        );
        assert(shared);
        expect(shared.exportDirectory).toBeUndefined();
        expect(readBackupEngine(shared.snapshotPath)).toEqual({ engine: "sqlite" });
        const entry = backup.databases.find((item) => item.path === anchorPath);
        assert(entry?.exportDirectory);
        // The rows stay on the server: no portable SQLite image is written.
        expect((await fs.readdir(entry.exportDirectory)).toSorted()).toEqual([
          "anchor.sqlite",
          "manifest.json",
        ]);
        const manifest = await verifyMatchedPostgresBackup(entry.exportDirectory, "exact", {
          storeId,
          namespace,
        });
        expect(manifest.carrier).toBe("postgres-schema");
        assert(manifest.schema);
        namespaces.add(manifest.schema);
        const live = await inspectDatabasePort(
          { engine: "postgres", db: client, namespace },
          descriptor,
          storeId,
        );
        expect(manifest.verification).toEqual({
          tables: live.tables,
          allocations: live.allocations,
        });

        await client.query(`UPDATE "${namespace}".workboard_cards SET title = 'Migrated'`);
        // A retry restores from the same frozen capture.
        for (const attempt of ["first", "retry"]) {
          const restored = await preparePostgresRestore({
            directory: entry.exportDirectory,
            anchorPath: state.path(`restored-${attempt}.sqlite`),
            config,
            profile: "exact",
            expectedSource: { storeId, namespace },
            assertCurrent() {},
          });
          namespaces.add(restored.namespace);
          expect(restored.namespace).not.toBe(manifest.schema);
          expect(await titles(restored.namespace)).toEqual([{ title: "Captured" }]);
        }
        expect(await titles(namespace)).toEqual([{ title: "Migrated" }]);
        const frozen = await inspectDatabasePort(
          { engine: "postgres", db: client, namespace: manifest.schema },
          descriptor,
          storeId,
        );
        expect(frozen.tables).toEqual(manifest.verification.tables);

        await discardPostgresSchemaCaptures(config, [entry.exportDirectory]);
        expect(await schemaExists(client, manifest.schema)).toBe(false);
      },
    ),
);

it.skipIf(!connection)("drops the capture schema when a capture fails after creating it", () =>
  withSeededWorkboard(async ({ state, client, namespace, storeId, anchorPath, descriptor }) => {
    const admitted = await admitDatabasePortDescriptor(
      { engine: "postgres", db: client, namespace },
      descriptor,
    );
    const failures = {
      // Inside the copy transaction.
      copy: async () => {
        let calls = 0;
        return () => {
          if (++calls === 4) {
            throw new Error("synthetic copy failure");
          }
        };
      },
      // After the copy committed: the anchor artifact is missing.
      anchor: async () => () => {},
      // After the copy committed: the manifest already exists.
      manifest: async (directory: string) => {
        await fs.writeFile(path.join(directory, "manifest.json"), "{}");
        return () => {};
      },
    };
    for (const [mode, prepare] of Object.entries(failures)) {
      const directory = state.path(`failed-${mode}`);
      await fs.mkdir(directory);
      if (mode !== "anchor") {
        await fs.copyFile(anchorPath, path.join(directory, "anchor.sqlite"));
      }
      const spy = vi.spyOn(client, "query");
      let created: string[];
      try {
        await expect(
          capturePostgresSchema({
            client,
            descriptor: admitted,
            anchor: { engine: "postgres", storeId, namespace },
            directory,
            assertCurrent: await prepare(directory),
          }),
        ).rejects.toThrow();
      } finally {
        created = spy.mock.calls.flatMap(([text]) => {
          const match =
            typeof text === "string" ? /CREATE SCHEMA "(restore_[a-f0-9]{32})"/.exec(text) : null;
          return match ? [match[1]!] : [];
        });
        spy.mockRestore();
      }
      expect(created, mode).toHaveLength(1);
      expect(await schemaExists(client, created[0]!), mode).toBe(false);
    }
  }),
);

it.skipIf(!connection)(
  "lets Doctor drop only its own capture schemas whose backup directory was removed",
  () =>
    withSeededWorkboard(async ({ state, client, namespaces, storeId, anchorPath, config }) => {
      const prefix = `${anchorPath}.pre-startup-migration-`;
      const capture = async (directory: string) => {
        const manifest = await capturePostgresBackup({
          sourcePath: anchorPath,
          directory,
          profile: "exact",
          carrier: "postgres-schema",
          config,
          assertCurrent() {},
        });
        assert(manifest.schema);
        namespaces.add(manifest.schema);
        return manifest.schema;
      };
      const removed = `${prefix}${randomUUID()}.postgres.bak`;
      const kept = `${prefix}${randomUUID()}.postgres.bak`;
      const update = state.path("update.databases", "workboard.sqlite.postgres");
      await fs.mkdir(path.dirname(update));
      const schemas = {
        removed: await capture(removed),
        kept: await capture(kept),
        update: await capture(update),
      };
      // A store restored from a capture lives in an unmarked restore_ namespace.
      const restored = await preparePostgresRestore({
        directory: kept,
        anchorPath: state.path("restored.sqlite"),
        config,
        profile: "exact",
        expectedSource: { storeId, namespace: readBackupEngineNamespace(anchorPath) },
        assertCurrent() {},
      });
      namespaces.add(restored.namespace);
      await fs.rm(removed, { recursive: true });
      await fs.rm(path.dirname(update), { recursive: true });

      expect(await prunePostgresSchemaCaptures(anchorPath, config, prefix)).toEqual([
        schemas.removed,
      ]);
      expect(await schemaExists(client, schemas.removed)).toBe(false);
      for (const schema of [schemas.kept, schemas.update, restored.namespace]) {
        expect(await schemaExists(client, schema), schema).toBe(true);
      }
      expect(await prunePostgresSchemaCaptures(anchorPath, config, prefix)).toEqual([]);
    }),
);

it.skipIf(!connection)(
  "keeps Doctor captures portable unless server recovery captures are chosen",
  () =>
    withSeededWorkboard(async ({ client, namespaces, anchorPath }) => {
      assert(connection);
      for (const server of [false, true]) {
        const input = { connection, schemaPrefix: "openclaw" };
        const { changes } = await backupDoctorPostgresMigration(
          anchorPath,
          server ? { ...input, serverRecoveryCaptures: true } : input,
          { assertAdmission() {} },
        );
        const directory = changes.at(-1)!.replace("Saved pre-migration PostgreSQL backup: ", "");
        const manifest = await verifyMatchedPostgresBackup(directory, "exact");
        if (manifest.schema) {
          namespaces.add(manifest.schema);
          expect(await schemaExists(client, manifest.schema)).toBe(true);
        }
        expect(manifest.carrier, String(server)).toBe(server ? "postgres-schema" : undefined);
        expect((await fs.readdir(directory)).includes("database.sqlite")).toBe(!server);
      }
    }),
);

it.skipIf(!connection)(
  "leaves another role's capture alone under the same directory prefix",
  async () => {
    assert(connection);
    const admin = new Client({ connectionString: connection });
    const id = () => randomUUID().replaceAll("-", "");
    const [runtime, foreign] = [`oc_runtime_${id()}`, `oc_foreign_${id()}`];
    const schemas = { [runtime]: `restore_${id()}`, [foreign]: `restore_${id()}` };
    // Two installs on separate hosts may share the same absolute state path.
    const prefix = `/missing-${id()}/state/openclaw.sqlite.pre-startup-migration-`;
    const storeId = randomUUID();
    await admin.connect();
    const url = new URL(connection);
    url.username = runtime;
    url.password = "";
    const client = new Client({ connectionString: url.toString() });
    try {
      await admin.query(`CREATE ROLE "${runtime}" LOGIN; CREATE ROLE "${foreign}" NOLOGIN`);
      for (const [owner, schema] of Object.entries(schemas)) {
        const marker = JSON.stringify({ openclawCapture: `${prefix}${randomUUID()}.postgres.bak` });
        await admin.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${owner}";
        CREATE TABLE "${schema}".openclaw_schema_meta (store_id text);
        ALTER TABLE "${schema}".openclaw_schema_meta OWNER TO "${owner}";
        INSERT INTO "${schema}".openclaw_schema_meta VALUES ('${storeId}');
        COMMENT ON SCHEMA "${schema}" IS '${marker}'`);
      }
      await client.connect();
      expect(
        await pruneOrphanedPostgresCaptures(client, { storeId, directoryPrefix: prefix }),
      ).toEqual([schemas[runtime]]);
      expect(await schemaExists(admin, schemas[foreign]!)).toBe(true);
    } finally {
      await client.end().catch(() => {});
      for (const schema of Object.values(schemas)) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      await admin.query(`DROP ROLE IF EXISTS "${runtime}"; DROP ROLE IF EXISTS "${foreign}"`);
      await admin.end();
    }
  },
);

function readBackupEngineNamespace(anchorPath: string) {
  const anchor = readBackupEngine(anchorPath);
  assert(anchor.engine === "postgres");
  return anchor.namespace;
}

it.skipIf(!connection)(
  "captures an agent store on PostgreSQL in a schema while state stays on SQLite",
  async () => {
    assert(connection);
    await withOpenClawTestState({ scenario: "minimal", prefix: "pg-mixed-" }, async (state) => {
      const client = new Client({ connectionString: connection });
      const namespace = `agent_${randomUUID().replaceAll("-", "")}`;
      const namespaces = new Set([namespace]);
      const storeId = randomUUID();
      const agentPath = path.join(state.agentDir("main"), "openclaw-agent.sqlite");
      const config: OpenClawConfig = {
        database: {
          families: { agent: { engine: "postgres" } },
          postgres: { connection, schemaPrefix: "mixed" },
        },
      };
      await state.writeConfig(config);
      await fs.mkdir(path.dirname(agentPath), { recursive: true });
      await client.connect();
      try {
        const descriptor = await agentPortProvider.loadDescriptor();
        {
          using source = openNodeSqliteDatabase(":memory:", { readBigInts: true });
          source.exec(descriptor.sqlite);
          source.exec(`INSERT INTO schema_meta VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', NULL, 1, 1);
            INSERT INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0);`);
          await materializeDatabasePort({
            source: { engine: "sqlite", db: source },
            destination: { engine: "postgres", db: client, namespace },
            descriptor,
            storeId,
            assertCurrent() {},
          });
        }
        writePortAnchor(agentPath, storeId, namespace);
        await descriptor.admit?.(agentPath, { connection, schemaPrefix: "mixed" });
        openOpenClawStateDatabase({ env: state.env });
        await closeOpenClawStateDatabaseAsync();
        const backup = await createUpdateDatabaseBackupWithFixtureTransport({
          backupRoot: state.path("update"),
          stateDir: state.stateDir,
          config,
          env: state.env,
          stopped: true,
          postgresSchemaCaptures: true,
        });
        const shared = backup.databases.find(
          (item) => item.path === state.statePath("state", "openclaw.sqlite"),
        );
        assert(shared);
        expect(readBackupEngine(shared.snapshotPath)).toEqual({ engine: "sqlite" });
        expect(shared.exportDirectory).toBeUndefined();
        const agent = backup.databases.find((item) => item.path === agentPath);
        assert(agent?.exportDirectory);
        expect((await fs.readdir(agent.exportDirectory)).toSorted()).toEqual([
          "anchor.sqlite",
          "manifest.json",
        ]);
        const manifest = await verifyMatchedPostgresBackup(agent.exportDirectory, "exact", {
          storeId,
          namespace,
        });
        assert(manifest.schema);
        namespaces.add(manifest.schema);
        expect(manifest).toMatchObject({ carrier: "postgres-schema", source: { owner: "agent" } });
        expect(
          (await client.query(`SELECT main_key FROM "${manifest.schema}".session_key_contract`))
            .rows,
        ).toEqual([{ main_key: "main" }]);
      } finally {
        await closeOpenClawStateDatabaseAsync();
        for (const owned of namespaces) {
          await client.query(`DROP SCHEMA IF EXISTS "${owned}" CASCADE`);
        }
        await client.end();
      }
    });
  },
);
