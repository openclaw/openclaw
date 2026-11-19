// Continuation (karmaterminal): recipient authority is agent schema 42, above upstream's
// PostgreSQL-only steps 34-36 and 38, the cold-archive chunk step 37, the cold-navigation step 39,
// the creation-receipt step 40 and the active-event-facts step 41. These cases run that ladder in
// place through the agent owner.
import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Client, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { agentEngineSchema, openAgentEngineStore } from "../../state/openclaw-agent-db-engine.js";
import { runWithAgentDatabaseMaintenanceAuthority } from "../../state/openclaw-agent-db-lease.js";
import { AGENT_RECIPIENT_AUTHORITY_SCHEMA_VERSION } from "../../state/openclaw-agent-recipient-authority-schema.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { publishSqliteDatabaseSchemaChange } from "../sqlite-database-admission.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { withDatabaseEngineSelection } from "./context.js";
import type { StoreSchema } from "./contract.js";
import { openPostgresEngineTestStore } from "./engine-store.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import { postgresCatalogQuery, readPostgresCatalog } from "./postgres-catalog.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterAll);
const step = (version: number) =>
  agentEngineSchema.postgresMigrations!.find((migration) => migration.version === version)!;
type Predecessor = ReturnType<typeof step>["fromSchema"];
/** A historical layout; search versions it omits stay historical instead of inheriting current. */
const historical = (version: number, from: Predecessor): StoreSchema => ({
  ...agentEngineSchema,
  ...from,
  postgresVectorDecoderVersion: from.postgresVectorDecoderVersion,
  postgresVectorSearchVersion: from.postgresVectorSearchVersion,
  postgresTextSearchVersion: from.postgresTextSearchVersion,
  version,
  postgresMigrations: [],
});
// Upstream's step 35 drops explicit NULLS ordering from these nullable-column indexes.
const step35Indexes = [
  "idx_agent_cache_expiry",
  "idx_agent_session_nodes_archived_at",
  "idx_agent_session_nodes_label",
  "idx_agent_session_nodes_status",
  "idx_agent_session_windows_conversation",
  "idx_agent_transcript_active_messages",
  "idx_agent_transcript_message_idempotency",
];

describe.skipIf(!connection)("PostgreSQL agent recipient-authority migration", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  const input = { connection: connection!, schemaPrefix: "authority_migration_test" };
  const selection = {
    effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
    postgres: input,
  };
  // Doctor holds this lease in production; the cases prove the schema owner behind it.
  const authority = {
    signal: new AbortController().signal,
    assertCurrent() {},
    assertOwned() {},
    assertOwnedInTransaction() {},
  };
  const rows = async <T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) =>
    (await client.query<T>(sql, values)).rows;
  beforeAll(() => client.connect());
  afterAll(async () => {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await client.end();
  });

  /** Bootstrap and seal a layout the way the binary that owned it did. */
  function install(schema: StoreSchema, anchorPath: string): string {
    return withEngineStoreAdmission(() => {
      using anchor = openNodeSqliteDatabase(anchorPath);
      const db = openPostgresEngineTestStore({ anchor, schema, input });
      try {
        if (!(db instanceof PostgresSyncConnection)) {
          throw new Error("Expected PostgreSQL");
        }
        namespaces.add(db.schema);
        return db.schema;
      } finally {
        db.close();
      }
    });
  }

  async function seed(namespace: string, version: number) {
    await client.query(`
      INSERT INTO "${namespace}".schema_meta VALUES ('primary', 'agent', ${version}, 'main', NULL, 1, 1);
      INSERT INTO "${namespace}".session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0);
      INSERT INTO "${namespace}".memory_index_state (id, revision) VALUES (1, 0);
      INSERT INTO "${namespace}".memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
        SELECT 'fixture', 'fixture', 'fixture', 'hash-' || n, decode('0102', 'hex'), 1, n * 10
        FROM generate_series(1, 3) AS n;
      INSERT INTO "${namespace}".session_nodes
        (session_key, current_session_id, entry_json, updated_at, status, label, archived_at)
        VALUES ('agent:main:main', 'active', '{"sessionId":"active"}', 2, NULL, NULL, NULL),
          ('agent:main:archived', 'archived', '{"sessionId":"archived"}', 1, 'done', 'Archived', 1);
      INSERT INTO "${namespace}".conversations
        (conversation_id, channel, account_id, kind, peer_id, delivery_target, created_at, updated_at)
        VALUES ('conversation', 'fixture', 'default', 'direct', 'peer', 'peer', 1, 1);
      INSERT INTO "${namespace}".session_windows
        (session_id, session_key, created_at, updated_at, primary_conversation_id)
        VALUES ('active', 'agent:main:main', 2, 2, NULL),
          ('archived', 'agent:main:archived', 1, 1, 'conversation');
      INSERT INTO "${namespace}".cache_entries (scope, key, value_json, expires_at, updated_at)
        VALUES ('fixture', 'durable', '"kept"', NULL, 1), ('fixture', 'expiring', '"kept"', 99, 1);
      INSERT INTO "${namespace}".transcript_events (session_id, seq, event_json, created_at)
        VALUES ('active', 1, '{"type":"message","id":"message"}', 1);
      INSERT INTO "${namespace}".transcript_event_identities
        (session_id, event_id, seq, event_type, message_idempotency_key, created_at)
        VALUES ('active', 'message', 1, 'message', 'idempotent', 1);
    `);
  }

  /** Doctor's agent migration call: the production opener on a fresh anchor handle. */
  function openAgent(
    anchorPath: string,
    beforeOpen?: (anchor: ReturnType<typeof openNodeSqliteDatabase>) => void,
  ) {
    return runWithAgentDatabaseMaintenanceAuthority(authority, anchorPath, async () =>
      withDatabaseEngineSelection(selection, () =>
        withEngineStoreAdmission(() => {
          using anchor = openNodeSqliteDatabase(anchorPath);
          beforeOpen?.(anchor);
          const db = openAgentEngineStore(anchor, "main", anchorPath, true);
          try {
            if (!isPostgresSqlConnection(db)) {
              throw new Error("Expected the PostgreSQL agent owner");
            }
            return getPostgresPhysicalFacts(db);
          } finally {
            db.close();
          }
        }),
      ),
    );
  }

  function observeStatements() {
    const statements: string[] = [];
    const observation = channel("openclaw.database.statement");
    const observe = (event: unknown) => {
      if (isRecord(event) && event.engine === "postgres" && typeof event.sql === "string") {
        statements.push(event.sql);
      }
    };
    observation.subscribe(observe);
    return {
      statements,
      [Symbol.dispose]: () => observation.unsubscribe(observe),
    };
  }

  // The catalog query does not order its aggregate; compare facts canonically, as fingerprints do.
  // Namespace-qualified definitions are relocated so separate stores compare too.
  async function catalog(namespace: string) {
    return readPostgresCatalog((await rows(postgresCatalogQuery(namespace, true)))[0]!.catalog)
      .map((fact) => JSON.stringify(fact).replaceAll(namespace, "fixture_namespace"))
      .toSorted();
  }

  async function snapshot(namespace: string) {
    const tables: Record<string, string> = {};
    for (const { relname } of await rows<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`,
      [namespace],
    )) {
      tables[relname] = (
        await rows<{ rows: string }>(`SELECT
          coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]')::text AS rows
          FROM "${namespace}"."${relname}" t`)
      )[0]!.rows;
    }
    return {
      tables,
      catalog: await catalog(namespace),
      relations: await rows<{
        name: string;
        kind: string;
        oid: string;
        filenode: string;
        definition: string | null;
      }>(
        `SELECT c.relname AS name, c.relkind::text AS kind, c.oid::text AS oid,
          c.relfilenode::text AS filenode,
          CASE WHEN c.relkind = 'i' THEN pg_get_indexdef(c.oid) END AS definition
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 ORDER BY c.relname`,
        [namespace],
      ),
    };
  }

  it("migrates a populated schema-34 store through 35-42 in place and re-admits it without DDL", async () => {
    const root = dirs.make("pg-authority-chain-");
    const anchorPath = path.join(root, "openclaw-agent.sqlite");
    const namespace = install(historical(34, step(35).fromSchema), anchorPath);
    await seed(namespace, 34);
    const reference = install(agentEngineSchema, path.join(root, "reference.sqlite"));
    const before = await snapshot(namespace);
    expect(before.tables.session_recipient_authority).toBeUndefined();
    expect(
      before.relations.find((index) => index.name === "idx_agent_session_windows_conversation")
        ?.definition,
    ).toContain("primary_conversation_id NULLS FIRST");

    expect(await openAgent(anchorPath)).toMatchObject({
      namespace,
      version: AGENT_RECIPIENT_AUTHORITY_SCHEMA_VERSION,
    });

    const after = await snapshot(namespace);
    expect(await rows(`SELECT version FROM "${namespace}".openclaw_schema_meta`)).toEqual([
      { version: String(AGENT_RECIPIENT_AUTHORITY_SCHEMA_VERSION) },
    ]);
    expect(
      await rows(`SELECT meta_key, role, schema_version, agent_id FROM "${namespace}".schema_meta`),
    ).toEqual([
      {
        meta_key: "primary",
        role: "agent",
        schema_version: String(AGENT_RECIPIENT_AUTHORITY_SCHEMA_VERSION),
        agent_id: "main",
      },
    ]);
    const { schema_meta: _version, openclaw_schema_meta: _seal, ...retained } = before.tables;
    expect(after.tables).toEqual({
      ...retained,
      schema_meta: after.tables.schema_meta,
      openclaw_schema_meta: after.tables.openclaw_schema_meta,
      session_creation_operations: "[]",
      session_recipient_authority: "[]",
      session_transcript_active_event_facts: "[]",
      session_transcript_cold_archive_chunks: "[]",
    });
    // The in-place result is the catalog a fresh schema-42 store bootstraps.
    expect(after.catalog).toEqual(await catalog(reference));
    // Step 35 rebuilds only its own indexes; every other relation keeps its storage.
    const rebuilt = before.relations
      .filter(
        (relation) =>
          after.relations.find((current) => current.name === relation.name)?.definition !==
          relation.definition,
      )
      .map((relation) => relation.name);
    expect(rebuilt).toEqual(step35Indexes);
    for (const relation of before.relations) {
      const current = after.relations.find((item) => item.name === relation.name);
      if (rebuilt.includes(relation.name)) {
        expect(current?.oid, relation.name).not.toBe(relation.oid);
        expect(current?.definition, relation.name).not.toMatch(/NULLS (?:FIRST|LAST)/u);
      } else {
        expect(current, relation.name).toEqual(relation);
      }
    }

    {
      using observation = observeStatements();
      // A changed schema revision makes the owner re-verify its seal instead of reusing facts.
      await openAgent(anchorPath, publishSqliteDatabaseSchemaChange);
      expect(observation.statements.length).toBeGreaterThan(0);
      expect(
        observation.statements.filter((sql) => /^\s*(?:CREATE|ALTER|DROP|DO)\b/iu.test(sql)),
      ).toEqual([]);
    }
    expect(await snapshot(namespace)).toEqual(after);
  });

  // Upstream's own 35-41 stores reach 42 in place and gain only the empty authority table (and,
  // below 37, 40 and 41, the empty cold-archive chunk, creation-receipt and active-event-facts
  // tables). 38 is upstream's text-search split, 39 its widened transcript payload constraint, 40
  // its creation receipts and 41 its active event facts.
  it.each([35, 36, 37, 38, 39, 40, 41])(
    "migrates upstream's populated schema-%i store to 42 in place and re-admits it without DDL",
    async (version) => {
      const root = dirs.make(`pg-authority-upstream-${version}-`);
      const anchorPath = path.join(root, "openclaw-agent.sqlite");
      const namespace = install(historical(version, step(version + 1).fromSchema), anchorPath);
      await seed(namespace, version);
      const reference = install(agentEngineSchema, path.join(root, "reference.sqlite"));
      const before = await snapshot(namespace);
      expect(before.tables.session_recipient_authority).toBeUndefined();

      expect(await openAgent(anchorPath)).toMatchObject({
        namespace,
        version: AGENT_RECIPIENT_AUTHORITY_SCHEMA_VERSION,
      });

      const after = await snapshot(namespace);
      const { schema_meta: _version, openclaw_schema_meta: _seal, ...retained } = before.tables;
      expect(after.tables).toEqual({
        ...retained,
        schema_meta: after.tables.schema_meta,
        openclaw_schema_meta: after.tables.openclaw_schema_meta,
        session_creation_operations: "[]",
        session_recipient_authority: "[]",
        session_transcript_active_event_facts: "[]",
        session_transcript_cold_archive_chunks: "[]",
      });
      expect(after.catalog).toEqual(await catalog(reference));
      {
        using observation = observeStatements();
        await openAgent(anchorPath, publishSqliteDatabaseSchemaChange);
        expect(
          observation.statements.filter((sql) => /^\s*(?:CREATE|ALTER|DROP|DO)\b/iu.test(sql)),
        ).toEqual([]);
      }
      expect(await snapshot(namespace)).toEqual(after);
    },
  );
});
