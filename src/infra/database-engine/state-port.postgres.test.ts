import "../../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitDatabasePortDescriptor } from "./port-descriptor.js";
import { sqliteDatabasePortProvider } from "./port-provider.js";
import { inspectDatabasePort, materializeDatabasePort } from "./port.worker.js";
import { statePortProvider } from "./state-port.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!connection)("shared-state database port", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  beforeAll(() => client.connect());
  afterAll(async () => {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await client.end();
  });

  it("ports the complete optional inventory, exact bytes, identities and retained transient state", async () => {
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
    source.exec(`PRAGMA user_version = 24;
      INSERT INTO schema_meta VALUES ('primary', 'global', 24, NULL, NULL, 1, 1);
      INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '24', 1);
      INSERT INTO state_leases VALUES ('test', 'lease', 'synthetic', 2, 1, NULL, 1, 1);
      INSERT INTO secret_store_entries VALUES ('team', '', 'synthetic', 'retained', 'secret', 1, 1, NULL, NULL, NULL);
      INSERT INTO plugin_blob_entries VALUES ('test', 'test', 'ttl', '{}', X'00ff80', 1, 2);
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
    expect(descriptor.inspectSqliteSource!(source)).toEqual({
      version: 24,
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
    expect((await client.query(`SELECT sequence FROM "${namespace}".audit_events`)).rows).toEqual([
      { sequence: "9007199254740993" },
    ]);
    expect(
      (
        await client.query(
          `INSERT INTO "${namespace}".audit_events (event_id, source_id, source_sequence, occurred_at, kind, action, status, actor_type, actor_id) VALUES ('next', 'next', 3, 1, 'test', 'test', 'ok', 'test', 'test') RETURNING sequence`,
        )
      ).rows,
    ).toEqual([{ sequence: "9007199254741000" }]);
    expect(Object.keys(staged.tables)).toHaveLength(134);
    expect(
      (await client.query(`SELECT display_name, avatar FROM "${namespace}".user_profiles`)).rows,
    ).toEqual([{ display_name: "Café 🦞", avatar: Buffer.from([0, 255, 128]) }]);
    expect(
      (await client.query(`SELECT value FROM "${namespace}".secret_store_entries`)).rows,
    ).toEqual([{ value: "retained" }]);
    expect(
      (await client.query(`SELECT count(*) AS count FROM "${namespace}".state_leases`)).rows[0]
        .count,
    ).toBe("1");
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
    namespaces.add(namespace);
    await materializeDatabasePort({
      source: { engine: "sqlite", db: source },
      destination: { engine: "postgres", db: client, namespace },
      descriptor,
      storeId: randomUUID(),
      assertCurrent() {},
    });
    expect(
      (
        await client.query(
          "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename IN ('agent_deletion_journal', 'user_profiles')",
          [namespace],
        )
      ).rows,
    ).toEqual([]);
  });

  it.todo(
    "PostgreSQL → SQLite and exact/user backup restore: pending R14a PostgreSQL maintenance custody",
  );
});
