import "../test-utils/prepare-compiled-subprocesses.js";
import "../infra/database-engine/backup-worker.test-support.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { materializeDatabasePort } from "../infra/database-engine/port.worker.js";
import { statePortProvider } from "../infra/database-engine/state-port.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  clonePostgresUpgrade,
  inspectPostgresUpgrade,
  preflightPostgresUpgrade,
  readBackupEngine,
  retirePostgresUpgrade,
  validatePostgresUpgrade,
} from "./database-backup.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!connection)("protected PostgreSQL upgrade carrier", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  beforeAll(() => client.connect());
  afterAll(async () => {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await client.end();
  });

  it("names the missing database CREATE grant before allocating any namespace", async (context) => {
    const admin = (
      await client.query<{ superuser: string; database: string }>(
        "SELECT current_setting('is_superuser') AS superuser, current_database() AS database",
      )
    ).rows[0]!;
    if (admin.superuser !== "on") {
      context.skip("Temporary role proof requires the conformance cluster superuser");
      return;
    }
    const id = randomUUID().replaceAll("-", "");
    const role = `upgrade_role_${id}`;
    const namespace = `upgrade_privilege_${id}`;
    const storeId = randomUUID();
    const anchorPath = path.join(directories.make("postgres-upgrade-grant-"), "anchor.sqlite");
    await client.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'synthetic-upgrade-fixture'`);
    try {
      await client.query(
        `CREATE SCHEMA "${namespace}" AUTHORIZATION "${role}";
         CREATE TABLE "${namespace}".openclaw_schema_meta (store TEXT, version BIGINT, store_id TEXT);
         GRANT SELECT ON "${namespace}".openclaw_schema_meta TO "${role}"`,
      );
      await client.query(
        `INSERT INTO "${namespace}".openclaw_schema_meta VALUES ('state', $1, $2)`,
        [OPENCLAW_STATE_SCHEMA_VERSION, storeId],
      );
      {
        using anchor = openNodeSqliteDatabase(anchorPath);
        anchor.exec(
          "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
        );
        anchor
          .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
          .run(storeId, namespace);
      }
      const restricted = new URL(connection!);
      restricted.username = role;
      restricted.password = "synthetic-upgrade-fixture";
      const config = {
        database: { engine: "postgres" as const, postgres: { connection: restricted.toString() } },
      };
      const before = (await client.query("SELECT nspname FROM pg_namespace ORDER BY nspname")).rows;
      const database = admin.database.replaceAll('"', '""');
      await expect(preflightPostgresUpgrade([anchorPath], config)).rejects.toThrow(
        `GRANT CREATE ON DATABASE "${database}" TO "${role}";`,
      );
      expect(
        (await client.query("SELECT nspname FROM pg_namespace ORDER BY nspname")).rows,
      ).toEqual(before);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE; DROP ROLE "${role}"`);
    }
  });

  it("keeps originals unchanged and retires only an inactive namespace bound to its anchor", async () => {
    const directory = directories.make("postgres-upgrade-");
    const sourcePath = path.join(directory, "source.sqlite");
    const shadowPath = path.join(directory, "shadow.sqlite");
    const storeId = randomUUID();
    const namespace = `upgrade_original_${storeId.replaceAll("-", "")}`;
    namespaces.add(namespace);
    const descriptor = await statePortProvider.loadDescriptor();
    {
      using source = openNodeSqliteDatabase(path.join(directory, "data.sqlite"));
      source.exec(descriptor.sqlite);
      for (const fragment of descriptor.fragments ?? []) {
        source.exec(fragment.sqlite);
      }
      source.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
        INSERT INTO schema_meta VALUES ('primary', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, NULL, NULL, 1, 1);
        INSERT INTO agent_deletion_journal
          (agent_id, agent_dir, workspace_dir, sessions_dir, created_at, cleanup_completed, delete_files)
        VALUES ('retained', '/retained', '/workspace', '/sessions', 1, 1, 0),
               ('deleted', '/deleted', '/workspace', '/sessions', 1, 1, 1);`);
      await materializeDatabasePort({
        source: { engine: "sqlite", db: source },
        destination: { engine: "postgres", db: client, namespace },
        descriptor,
        storeId,
        assertCurrent() {},
      });
    }
    {
      using anchor = openNodeSqliteDatabase(sourcePath);
      anchor.exec(
        "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
      );
      anchor
        .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
        .run(storeId, namespace);
    }
    const config = { database: { engine: "postgres" as const, postgres: { connection } } };
    const originalBytes = await fs.readFile(sourcePath);
    expect(await inspectPostgresUpgrade(sourcePath, config)).toMatchObject({
      family: "state",
      namespace,
      storeId,
      version: OPENCLAW_STATE_SCHEMA_VERSION,
      retainedAgentIds: ["retained"],
    });
    await preflightPostgresUpgrade([sourcePath], config);
    // The ordinary tree copy has already placed the original anchor in the shadow.
    await fs.copyFile(sourcePath, shadowPath);
    const clone = await clonePostgresUpgrade(sourcePath, shadowPath, config);
    namespaces.add(clone.namespace);
    expect(clone.namespace).not.toBe(namespace);
    expect(readBackupEngine(shadowPath)).toEqual({
      engine: "postgres",
      storeId,
      namespace: clone.namespace,
    });
    await validatePostgresUpgrade(shadowPath, config, OPENCLAW_STATE_SCHEMA_VERSION);
    await expect(
      validatePostgresUpgrade(shadowPath, config, OPENCLAW_STATE_SCHEMA_VERSION + 1),
    ).rejects.toThrow("expected");
    await client.query(
      `UPDATE "${clone.namespace}".agent_deletion_journal SET agent_dir = '/private' WHERE agent_id = 'retained'`,
    );
    expect(
      (
        await client.query(
          `SELECT agent_dir FROM "${namespace}".agent_deletion_journal WHERE agent_id = 'retained'`,
        )
      ).rows,
    ).toEqual([{ agent_dir: "/retained" }]);
    expect(await fs.readFile(sourcePath)).toEqual(originalBytes);
    await expect(
      retirePostgresUpgrade(sourcePath, config, [sourcePath, shadowPath]),
    ).rejects.toThrow("active");
    const foreignAnchor = path.join(directory, "foreign.sqlite");
    await fs.copyFile(sourcePath, foreignAnchor);
    {
      using anchor = openNodeSqliteDatabase(foreignAnchor);
      anchor.prepare("UPDATE openclaw_engine_anchor SET store_id = ?").run(randomUUID());
    }
    await expect(retirePostgresUpgrade(foreignAnchor, config, [shadowPath])).rejects.toThrow(
      "store metadata",
    );
    expect(
      (await client.query("SELECT to_regnamespace($1) IS NOT NULL AS present", [namespace])).rows,
    ).toEqual([{ present: true }]);
    // The original did not use restore_*: exact role ownership and its store ID authorize adoption.
    await retirePostgresUpgrade(sourcePath, config, [shadowPath]);
    expect(
      (await client.query("SELECT to_regnamespace($1) IS NOT NULL AS present", [namespace])).rows,
    ).toEqual([{ present: false }]);
    await validatePostgresUpgrade(shadowPath, config, OPENCLAW_STATE_SCHEMA_VERSION);
  }, 60_000);
});
