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
} from "./database-backup.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!connection)("protected PostgreSQL upgrade carrier", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  const roles = new Set<string>();
  const runtimeClients = new Set<Client>();
  beforeAll(() => client.connect());
  afterAll(async () => {
    for (const runtimeClient of runtimeClients) {
      await runtimeClient.end();
    }
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    for (const role of roles) {
      const identifier = `"${role.replaceAll('"', '""')}"`;
      await client.query(`DROP OWNED BY ${identifier}; DROP ROLE ${identifier}`);
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

  it.each([
    { sourceVersion: OPENCLAW_STATE_SCHEMA_VERSION, sourceLayout: "current" },
    { sourceVersion: 39, sourceLayout: "with bootstrap_deferred" },
    { sourceVersion: 39, sourceLayout: "without bootstrap_deferred" },
  ])(
    "preserves runtime-owned ACLs and source data through cloning and retirement for v$sourceVersion ($sourceLayout)",
    async ({ sourceVersion, sourceLayout }) => {
      const directory = directories.make("postgres-upgrade-");
      const sourcePath = path.join(directory, "source.sqlite");
      const shadowPath = path.join(directory, "shadow.sqlite");
      const storeId = randomUUID();
      const namespace = `upgrade_original_${storeId.replaceAll("-", "")}`;
      namespaces.add(namespace);
      const reader = `upgrade_reader_${storeId.replaceAll("-", "")}`;
      const columnReader = `upgrade_columns_"_${storeId.replaceAll("-", "")}`;
      const columnReaderIdentifier = `"${columnReader.replaceAll('"', '""')}"`;
      for (const role of [reader, columnReader]) {
        await client.query(`CREATE ROLE "${role.replaceAll('"', '""')}"`);
        roles.add(role);
      }
      const runtime = `upgrade_runtime_${storeId.replaceAll("-", "")}`;
      await client.query(
        `CREATE ROLE "${runtime}" LOGIN NOSUPERUSER PASSWORD 'synthetic-upgrade-runtime'`,
      );
      roles.add(runtime);
      await client.query(`GRANT "${reader}", ${columnReaderIdentifier} TO "${runtime}"`);
      const runtimeConnection = new URL(connection!);
      runtimeConnection.username = runtime;
      runtimeConnection.password = "synthetic-upgrade-runtime";
      const runtimeClient = new Client({ connectionString: runtimeConnection.toString() });
      runtimeClients.add(runtimeClient);
      await runtimeClient.connect();
      const database = (
        await runtimeClient.query<{ database: string }>("SELECT current_database() AS database")
      ).rows[0]!.database;
      await client.query(
        `GRANT CREATE ON DATABASE "${database.replaceAll('"', '""')}" TO "${runtime}"`,
      );
      expect(
        (
          await runtimeClient.query(
            "SELECT current_user AS role, current_setting('is_superuser') AS superuser",
          )
        ).rows,
      ).toEqual([{ role: runtime, superuser: "off" }]);
      const asRole = async <T>(role: string, operation: () => Promise<T>): Promise<T> => {
        await runtimeClient.query(`SET ROLE "${role.replaceAll('"', '""')}"`);
        try {
          return await operation();
        } finally {
          await runtimeClient.query("RESET ROLE");
        }
      };
      const readRows = async (selectedNamespace: string) =>
        (
          await runtimeClient.query(
            `SELECT agent_id, agent_dir FROM "${selectedNamespace}".agent_deletion_journal ORDER BY agent_id`,
          )
        ).rows;
      const expectedRows = [
        { agent_id: "deleted", agent_dir: "/deleted" },
        { agent_id: "retained", agent_dir: "/retained" },
      ];
      let descriptor = await statePortProvider.loadDescriptor(undefined, sourceVersion);
      if (sourceLayout === "without bootstrap_deferred") {
        descriptor = descriptor.selectSourceLayout!(() => false);
      }
      {
        using source = openNodeSqliteDatabase(path.join(directory, "data.sqlite"));
        source.exec(descriptor.sqlite);
        for (const fragment of descriptor.fragments ?? []) {
          source.exec(fragment.sqlite);
        }
        source.exec(`PRAGMA user_version = ${sourceVersion};
        INSERT INTO schema_meta VALUES ('primary', 'global', ${sourceVersion}, NULL, NULL, 1, 1);
        INSERT INTO agent_deletion_journal
          (agent_id, agent_dir, workspace_dir, sessions_dir, created_at, cleanup_completed, delete_files)
        VALUES ('retained', '/retained', '/workspace', '/sessions', 1, 1, 0),
               ('deleted', '/deleted', '/workspace', '/sessions', 1, 1, 1);`);
        await materializeDatabasePort({
          source: { engine: "sqlite", db: source },
          destination: { engine: "postgres", db: runtimeClient, namespace },
          descriptor,
          storeId,
          assertCurrent() {},
        });
      }
      // Real engine bootstrap adds these seal and extension fields beyond the transport metadata.
      await runtimeClient.query(
        `ALTER TABLE "${namespace}".openclaw_schema_meta
           ADD COLUMN fingerprint TEXT,
           ADD COLUMN ddl_hash TEXT,
           ADD COLUMN server_major BIGINT,
           ADD COLUMN search_extensions TEXT`,
      );
      await runtimeClient.query(
        `GRANT USAGE ON SCHEMA "${namespace}" TO "${reader}", ${columnReaderIdentifier};
       GRANT SELECT ON "${namespace}".agent_deletion_journal TO "${reader}" WITH GRANT OPTION;
       GRANT SELECT ON "${namespace}".openclaw_schema_meta TO "${reader}";
       ALTER DEFAULT PRIVILEGES IN SCHEMA "${namespace}" GRANT SELECT ON TABLES TO "${reader}"`,
      );
      await asRole(reader, () =>
        runtimeClient.query(
          `GRANT SELECT (agent_id, agent_dir) ON "${namespace}".agent_deletion_journal TO ${columnReaderIdentifier}`,
        ),
      );
      const metadataAclQuery = `SELECT acl.grantor::regrole::text AS grantor,
           acl.grantee::regrole::text AS grantee, acl.privilege_type, acl.is_grantable
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
              LATERAL aclexplode(c.relacl) acl
         WHERE n.nspname = $1 AND c.relname = 'openclaw_schema_meta'
         ORDER BY grantor, grantee, acl.privilege_type`;
      const originalMetadataAcl = (await runtimeClient.query(metadataAclQuery, [namespace])).rows;
      const sourceAclQuery = `SELECT 'schema' AS object, nspname AS name, nspacl::text AS acl
         FROM pg_namespace WHERE nspname = $1
       UNION ALL
       SELECT 'relation', c.relname, c.relacl::text
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relacl IS NOT NULL
       UNION ALL
       SELECT 'column', c.relname || '.' || a.attname, a.attacl::text
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND a.attacl IS NOT NULL
       UNION ALL
       SELECT 'default', d.defaclrole::regrole::text || ':' || d.defaclobjtype::text, d.defaclacl::text
         FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
         WHERE n.nspname = $1
       ORDER BY object, name`;
      const originalAcls = (await runtimeClient.query(sourceAclQuery, [namespace])).rows;
      expect(await asRole(reader, () => readRows(namespace))).toEqual(expectedRows);
      expect(await asRole(columnReader, () => readRows(namespace))).toEqual(expectedRows);
      {
        using anchor = openNodeSqliteDatabase(sourcePath);
        anchor.exec(
          "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
        );
        anchor
          .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
          .run(storeId, namespace);
      }
      const config = {
        database: {
          engine: "postgres" as const,
          postgres: { connection: runtimeConnection.toString() },
        },
      };
      const originalBytes = await fs.readFile(sourcePath);
      expect(await inspectPostgresUpgrade(sourcePath, config)).toMatchObject({
        family: "state",
        namespace,
        storeId,
        version: sourceVersion,
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
      // This is an actual reader query: a missing private-schema grant must fail with permission denied.
      expect(await asRole(reader, () => readRows(clone.namespace))).toEqual(expectedRows);
      await asRole(reader, async () => {
        expect(
          (
            await runtimeClient.query(
              `SELECT store_id FROM "${clone.namespace}".openclaw_schema_meta`,
            )
          ).rows,
        ).toEqual([{ store_id: storeId }]);
        await expect(
          runtimeClient.query(
            `UPDATE "${clone.namespace}".agent_deletion_journal SET agent_dir = '/unauthorized' WHERE false`,
          ),
        ).rejects.toMatchObject({ code: "42501" });
      });
      await asRole(columnReader, async () => {
        expect(await readRows(clone.namespace)).toEqual(expectedRows);
        await expect(
          runtimeClient.query(
            `SELECT workspace_dir FROM "${clone.namespace}".agent_deletion_journal`,
          ),
        ).rejects.toMatchObject({ code: "42501" });
      });
      expect((await runtimeClient.query(metadataAclQuery, [clone.namespace])).rows).toEqual(
        originalMetadataAcl,
      );
      expect(
        (
          await runtimeClient.query(
            `SELECT acl.grantor::regrole::text AS grantor, acl.is_grantable
             FROM pg_attribute a, LATERAL aclexplode(a.attacl) acl
             WHERE a.attrelid = $1::regclass AND a.attname = 'agent_id'
               AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = $2)`,
            [`"${clone.namespace}".agent_deletion_journal`, columnReader],
          )
        ).rows,
      ).toEqual([{ grantor: reader, is_grantable: false }]);
      expect(
        (
          await runtimeClient.query(
            `SELECT has_table_privilege($1, $3, 'SELECT WITH GRANT OPTION') AS reader_can_grant,
                  has_schema_privilege($1, $4, 'CREATE') AS reader_can_create,
                  has_table_privilege($2, $3, 'SELECT') AS column_reader_can_read_table,
                  has_column_privilege($2, $3, 'agent_id', 'SELECT WITH GRANT OPTION') AS column_reader_can_grant`,
            [reader, columnReader, `"${clone.namespace}".agent_deletion_journal`, clone.namespace],
          )
        ).rows,
      ).toEqual([
        {
          reader_can_grant: true,
          reader_can_create: false,
          column_reader_can_read_table: false,
          column_reader_can_grant: false,
        },
      ]);
      for (const selectedNamespace of [namespace, clone.namespace]) {
        expect(
          (
            await runtimeClient.query(
              `SELECT n.nspowner::regrole::text AS schema_owner,
                    ARRAY(SELECT DISTINCT c.relowner::regrole::text FROM pg_class c
                          WHERE c.relnamespace = n.oid) AS relation_owners,
                    EXISTS(SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
                           WHERE c.relnamespace = n.oid AND c.relname = 'workspace_setup_state'
                             AND a.attname = 'bootstrap_deferred' AND NOT a.attisdropped) AS bootstrap_deferred
               FROM pg_namespace n WHERE n.nspname = $1`,
              [selectedNamespace],
            )
          ).rows,
        ).toEqual([
          {
            schema_owner: runtime,
            relation_owners: [runtime],
            bootstrap_deferred: sourceLayout !== "without bootstrap_deferred",
          },
        ]);
      }
      await runtimeClient.query(
        `UPDATE "${clone.namespace}".agent_deletion_journal SET agent_dir = '/private' WHERE agent_id = 'retained'`,
      );
      expect(
        (
          await runtimeClient.query(
            `SELECT agent_dir FROM "${namespace}".agent_deletion_journal WHERE agent_id = 'retained'`,
          )
        ).rows,
      ).toEqual([{ agent_dir: "/retained" }]);
      expect(await fs.readFile(sourcePath)).toEqual(originalBytes);
      expect(await asRole(reader, () => readRows(namespace))).toEqual(expectedRows);
      expect((await runtimeClient.query(sourceAclQuery, [namespace])).rows).toEqual(originalAcls);
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
        (
          await runtimeClient.query("SELECT to_regnamespace($1) IS NOT NULL AS present", [
            namespace,
          ])
        ).rows,
      ).toEqual([{ present: true }]);
      // The original did not use restore_*: exact role ownership and its store ID authorize adoption.
      await retirePostgresUpgrade(sourcePath, config, [shadowPath]);
      expect(
        (
          await runtimeClient.query("SELECT to_regnamespace($1) IS NOT NULL AS present", [
            namespace,
          ])
        ).rows,
      ).toEqual([{ present: false }]);
      // This extra table models a later schema migration after retiring the original namespace.
      await runtimeClient.query(
        `CREATE TABLE "${clone.namespace}".future_reader_data (value TEXT NOT NULL);
       INSERT INTO "${clone.namespace}".future_reader_data VALUES ('future private row')`,
      );
      await asRole(reader, async () => {
        expect(
          (await runtimeClient.query(`SELECT value FROM "${clone.namespace}".future_reader_data`))
            .rows,
        ).toEqual([{ value: "future private row" }]);
        await expect(
          runtimeClient.query(
            `UPDATE "${clone.namespace}".future_reader_data SET value = 'unauthorized'`,
          ),
        ).rejects.toMatchObject({ code: "42501" });
      });
      await asRole(columnReader, async () => {
        await expect(
          runtimeClient.query(`SELECT value FROM "${clone.namespace}".future_reader_data`),
        ).rejects.toMatchObject({ code: "42501" });
      });
    },
    60_000,
  );
});
