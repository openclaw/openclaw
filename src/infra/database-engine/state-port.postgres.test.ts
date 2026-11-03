import "../../test-utils/prepare-compiled-subprocesses.js";
import "./backup-worker.test-support.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { decodeWorkStateJson } from "../../auto-reply/continuation/work-flow-state.js";
import {
  capturePostgresBackup,
  preparePostgresRestore,
  readBackupEngine,
} from "../../snapshot/database-backup.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitDatabasePortDescriptor } from "./port-descriptor.js";
import { sqliteDatabasePortProvider } from "./port-provider.js";
import { inspectDatabasePort, materializeDatabasePort } from "./port.worker.js";
import { statePortProvider } from "./state-port.js";

// karmaterminal/openclaw#1271: continue_work state with and without its recipient-authority field.
const oldWorkState = {
  kind: "continuation_work",
  sessionKey: "agent:main:ported",
  hop: 1,
  delayMs: 60_000,
  electedAt: 1,
  dueAt: 60_001,
  maxChainLength: 8,
};
const boundWorkState = {
  ...oldWorkState,
  recipientAuthority: { state: "bound", epoch: "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f" },
};

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!connection)("shared-state database port", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  const rows = async (sql: string, values?: unknown[]) => (await client.query(sql, values)).rows;
  beforeAll(() => client.connect());
  afterAll(async () => {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await client.end();
  });

  it("round-trips the complete inventory and restores exact and sanitized backups", async () => {
    const descriptor = await statePortProvider.loadDescriptor();
    const directory = tempDirs.make("state-port-");
    const sourcePath = path.join(directory, "state.sqlite");
    const anchorPath = path.join(directory, "anchor.sqlite");
    const storeId = randomUUID();
    const namespace = `state_port_${storeId.replaceAll("-", "")}`;
    namespaces.add(namespace);
    using source = openNodeSqliteDatabase(sourcePath);
    source.exec(descriptor.sqlite);
    for (const fragment of descriptor.fragments ?? []) {
      source.exec(fragment.sqlite);
    }
    source.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
      INSERT INTO schema_meta VALUES ('primary', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, NULL, NULL, 1, 1);
      INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '${OPENCLAW_STATE_SCHEMA_VERSION}', 1);
      INSERT INTO state_leases VALUES ('test', 'lease', 'synthetic', 2, 1, NULL, 1, 1);
      INSERT INTO secret_store_entries VALUES ('team', '', 'synthetic', 'retained', 'secret', 1, 1, NULL, NULL, NULL);
      INSERT INTO plugin_blob_entries VALUES ('test', 'test', 'ttl', '{}', X'00ff80', 1, 2);
      INSERT INTO plugin_blob_entries VALUES ('test', 'test', 'durable', '{}', X'00ff80', 1, NULL);
      INSERT INTO user_profiles VALUES ('profile', 'Café 🦞', NULL, X'00ff80', NULL, NULL, NULL, NULL, 1, 1);
      INSERT INTO user_profile_emails VALUES ('profile@example.invalid', 'profile', NULL, 1);
      INSERT INTO audit_events (sequence, event_id, source_id, source_sequence, occurred_at, kind, action, status, actor_type, actor_id)
      VALUES (9007199254740993, 'retained', 'retained', 1, 1, 'test', 'test', 'ok', 'test', 'test');
      INSERT INTO audit_events (sequence, event_id, source_id, source_sequence, occurred_at, kind, action, status, actor_type, actor_id)
      VALUES (9007199254740999, 'deleted', 'deleted', 2, 1, 'test', 'test', 'ok', 'test', 'test');
      DELETE FROM audit_events WHERE event_id = 'deleted';
      INSERT INTO device_pairing_join_codes VALUES (NULL, NULL, NULL, NULL), ('same', '{}', 1, 2), ('same', '{}', 1, 2);`);
    for (const key of ["newline\n", 'quote"', "slash\\"]) {
      source.prepare("INSERT INTO user_preferences VALUES ('profile', ?, '{}', 1)").run(key);
    }
    for (const [id, state] of Object.entries({ bound: boundWorkState, old: oldWorkState })) {
      source
        .prepare(
          "INSERT INTO continuation_records (record_id, kind, owner_session_key, revision, status, created_at, updated_at, due_at, state_json) VALUES (?, 'work', 'agent:main:ported', 0, 'queued', 1, 1, 60001, ?)",
        )
        .run(id, JSON.stringify(state));
    }
    const decodeWork = (records: unknown[]) =>
      (records as Array<{ state_json: string }>).map((row) =>
        decodeWorkStateJson(JSON.parse(row.state_json)),
      );
    expect(descriptor.inspectSqliteSource!(source)).toEqual({
      version: OPENCLAW_STATE_SCHEMA_VERSION,
      migrationRequired: false,
      pendingColumns: {},
    });
    const sourceBytes = fs.readFileSync(sourcePath);
    expect(sqliteDatabasePortProvider(source).id).toBe("state");
    const before = await inspectDatabasePort({ engine: "sqlite", db: source }, descriptor);
    const staged = await materializeDatabasePort({
      source: { engine: "sqlite", db: source },
      destination: { engine: "postgres", db: client, namespace },
      descriptor,
      storeId,
      assertCurrent() {},
    });
    expect(staged).toEqual({ tables: before.tables, allocations: before.allocations });
    const plannerRows = (schema: string) =>
      rows(
        `SELECT c.reltuples FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = 'user_profiles'`,
        [schema],
      );
    expect(await plannerRows(namespace)).toEqual([{ reltuples: 1 }]);
    expect(await rows(`SELECT sequence FROM "${namespace}".audit_events`)).toEqual([
      { sequence: "9007199254740993" },
    ]);
    // Continuation (karmaterminal): the first-use continuation_records custody table ports too.
    expect(Object.keys(staged.tables)).toHaveLength(137);
    expect(Object.keys(staged.tables)).toContain("continuation_records");
    expect(
      decodeWork(
        await rows(`SELECT state_json FROM "${namespace}".continuation_records ORDER BY record_id`),
      ),
    ).toEqual([boundWorkState, oldWorkState]);
    expect(await rows(`SELECT display_name, avatar FROM "${namespace}".user_profiles`)).toEqual([
      { display_name: "Café 🦞", avatar: Buffer.from([0, 255, 128]) },
    ]);
    expect(await rows(`SELECT value FROM "${namespace}".secret_store_entries`)).toEqual([
      { value: "retained" },
    ]);
    expect((await rows(`SELECT count(*) AS count FROM "${namespace}".state_leases`))[0].count).toBe(
      "1",
    );
    {
      using destination = openNodeSqliteDatabase(path.join(directory, "roundtrip.sqlite"));
      expect(
        await materializeDatabasePort({
          source: { engine: "postgres", db: client, namespace },
          destination: { engine: "sqlite", db: destination },
          descriptor,
          storeId,
          assertCurrent() {},
        }),
      ).toEqual(staged);
      expect(destination.prepare("SELECT display_name, avatar FROM user_profiles").get()).toEqual({
        display_name: "Café 🦞",
        avatar: Uint8Array.from([0, 255, 128]),
      });
      expect(
        decodeWork(
          destination
            .prepare("SELECT state_json FROM continuation_records ORDER BY record_id")
            .all(),
        ),
      ).toEqual([boundWorkState, oldWorkState]);
      const next = destination.prepare(
        "INSERT INTO audit_events (event_id, source_id, source_sequence, occurred_at, kind, action, status, actor_type, actor_id) VALUES ('next', 'next', 3, 1, 'test', 'test', 'ok', 'test', 'test') RETURNING sequence",
      );
      next.setReadBigInts(true);
      expect(next.get()).toEqual({ sequence: 9007199254741000n });
    }
    {
      using anchor = openNodeSqliteDatabase(anchorPath);
      anchor.exec(
        "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
      );
      anchor
        .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
        .run(storeId, namespace);
    }
    // Exercise normal R2 admission, including its exact catalog comparison.
    await descriptor.admit!(anchorPath, { connection: connection!, schemaPrefix: "test" });
    const config = { database: { engine: "postgres" as const, postgres: { connection } } };
    const anchorBytes = fs.readFileSync(anchorPath);
    for (const profile of ["exact", "user-backup"] as const) {
      const backupDirectory = path.join(directory, profile);
      const manifest = await capturePostgresBackup({
        sourcePath: anchorPath,
        directory: backupDirectory,
        profile,
        config,
        assertCurrent() {},
      });
      expect(manifest.activeFragments).toHaveLength(descriptor.fragments!.length);
      expect(manifest.sanitizedDifferences).toEqual(profile === "exact" ? [] : ["transient-state"]);
      if (profile === "exact") {
        expect(manifest.verification).toEqual(staged);
      }
      const restoredPath = path.join(directory, `${profile}-restored.sqlite`);
      const restored = await preparePostgresRestore({
        directory: backupDirectory,
        anchorPath: restoredPath,
        config,
        profile,
        assertCurrent() {},
      });
      namespaces.add(restored.namespace);
      expect(await plannerRows(restored.namespace)).toEqual([{ reltuples: 1 }]);
      expect(readBackupEngine(restoredPath)).toEqual({
        engine: "postgres",
        storeId,
        namespace: restored.namespace,
      });
      expect(restored.sha256).toBe(
        createHash("sha256").update(fs.readFileSync(restoredPath)).digest("hex"),
      );
      expect(
        await rows(`SELECT display_name, avatar FROM "${restored.namespace}".user_profiles`),
      ).toEqual([{ display_name: "Café 🦞", avatar: Buffer.from([0, 255, 128]) }]);
      expect(await rows(`SELECT value FROM "${restored.namespace}".secret_store_entries`)).toEqual([
        { value: "retained" },
      ]);
      expect(
        await rows(`SELECT count(*) AS count FROM "${restored.namespace}".state_leases`),
      ).toEqual([{ count: profile === "exact" ? "1" : "0" }]);
      expect(
        await rows(
          `SELECT entry_key FROM "${restored.namespace}".plugin_blob_entries ORDER BY entry_key`,
        ),
      ).toEqual(
        profile === "exact"
          ? [{ entry_key: "durable" }, { entry_key: "ttl" }]
          : [{ entry_key: "durable" }],
      );
      expect(fs.readFileSync(anchorPath)).toEqual(anchorBytes);
    }
    expect(
      await rows(
        `INSERT INTO "${namespace}".audit_events (event_id, source_id, source_sequence, occurred_at, kind, action, status, actor_type, actor_id) VALUES ('next', 'next', 3, 1, 'test', 'test', 'ok', 'test', 'test') RETURNING sequence`,
      ),
    ).toEqual([{ sequence: "9007199254741000" }]);
    await client.query(`DROP INDEX "${namespace}".idx_state_leases_owner`);
    await expect(
      descriptor.admit!(anchorPath, { connection: connection!, schemaPrefix: "test" }),
    ).rejects.toThrow(/schema drift/);
    expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
  });

  it("retains absence of optional fragments and Doctor-owned history", async () => {
    const descriptor = await statePortProvider.loadDescriptor();
    using source = openNodeSqliteDatabase(":memory:");
    source.exec(descriptor.sqlite);
    const admitted = await admitDatabasePortDescriptor(
      { engine: "sqlite", db: source },
      descriptor,
    );
    expect(admitted.activeFragments).toEqual([]);
    const namespace = `state_port_${randomUUID().replaceAll("-", "")}`;
    const storeId = randomUUID();
    namespaces.add(namespace);
    await materializeDatabasePort({
      source: { engine: "sqlite", db: source },
      destination: { engine: "postgres", db: client, namespace },
      descriptor,
      storeId,
      assertCurrent() {},
    });
    expect(
      await rows(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename IN ('agent_deletion_journal', 'user_profiles')",
        [namespace],
      ),
    ).toEqual([]);
    using destination = openNodeSqliteDatabase(":memory:");
    await materializeDatabasePort({
      source: { engine: "postgres", db: client, namespace },
      destination: { engine: "sqlite", db: destination },
      descriptor,
      storeId,
      assertCurrent() {},
    });
    expect(
      destination
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name IN ('agent_deletion_journal', 'user_profiles')",
        )
        .all(),
    ).toEqual([]);
  });
});
