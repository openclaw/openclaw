// Continuation (karmaterminal): Doctor's exact pre-migration PostgreSQL export of upstream's agent
// schemas 39 and 40, the migration to recipient authority (42), and its exact restore.
import "./backup-worker.test-support.js";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Client, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { backupDoctorPostgresMigration } from "../../commands/doctor-postgres-migration.js";
import { prepareDoctorDatabaseMigrations } from "../../commands/doctor-schema-migrations.js";
import { deriveTranscriptPredicateFields } from "../../config/sessions/transcript-predicate-fields.js";
import {
  preparePostgresRestore,
  readBackupEngine,
  verifyMatchedPostgresBackup,
} from "../../snapshot/database-backup.js";
import { AGENT_ACTIVE_EVENT_FACTS_SCHEMA_VERSION } from "../../state/openclaw-agent-active-event-facts-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { agentEngineSchema } from "../../state/openclaw-agent-db-engine.js";
import { AGENT_RECIPIENT_AUTHORITY_SCHEMA_VERSION } from "../../state/openclaw-agent-recipient-authority-schema.js";
import { withOpenClawStateReadOnlyLocation } from "../../state/openclaw-state-db-read-connection.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createMockStateReadSource } from "../../state/openclaw-state-read-mock.test-support.js";
import type * as StateReadWorker from "../../state/openclaw-state-read-worker.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadLocation,
} from "../../state/openclaw-state-read.types.js";
import { stateBootstrapReadOperations } from "../../state/state-bootstrap-read.worker.js";
import { acquireGatewayLock } from "../gateway-lock.js";
import { inspectGatewayOwnerLease } from "../gateway-owner-lease.worker.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { publishSqliteDatabaseSchemaChange } from "../sqlite-database-admission.js";
import { installDatabaseProcessRole, withEngineStoreAdmission } from "./admission-scope.js";
import { rebuildAgentPortProjections } from "./agent-port-projections.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import type { StoreSchema } from "./contract.js";
import { openEngineStore } from "./open.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import { postgresCatalogQuery, readPostgresCatalog } from "./postgres-catalog.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

// Keep the state read contracts in-process, as the Doctor PostgreSQL suite does.
const reads = vi.hoisted(() => ({
  capture: vi.fn<typeof StateReadWorker.captureOpenClawStateReadSource>(),
  retire: vi.fn<typeof StateReadWorker.retireIdleOpenClawStateReadWorkers>(),
}));
// mock-isolation: Install transport before cyclic state imports so Doctor's state reads stay in-process.
vi.mock("../../state/openclaw-state-read-worker.js", () => ({
  captureOpenClawStateReadSource: reads.capture,
  retireIdleOpenClawStateReadWorkers: reads.retire,
}));
// One case fails the real export while it copies the first transcript row.
const injected = vi.hoisted(() => ({ failOnTable: undefined as string | undefined }));
vi.mock("./port.worker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./port.worker.js")>();
  return {
    ...actual,
    materializeDatabasePort: (params: Parameters<typeof actual.materializeDatabasePort>[0]) =>
      actual.materializeDatabasePort({
        ...params,
        transformRow: (table, row) => {
          if (table === injected.failOnTable) {
            throw new Error(`Injected export failure while copying ${table}`);
          }
          return params.transformRow ? params.transformRow(table, row) : row;
        },
      }),
  };
});

async function readInProcess(command: OpenClawStateReadCommand, source: OpenClawStateReadLocation) {
  const databasePath = source.context.admission.databasePath;
  if (command.type === "stateBootstrap.inspect" || command.type === "stateBootstrap.ownership") {
    return withEngineStoreAdmission(() =>
      withOpenClawStateReadOnlyLocation(
        ({ db }) => ({
          ok: true as const,
          sourceAdmitted: true as const,
          ...(command.type === "stateBootstrap.inspect"
            ? stateBootstrapReadOperations[command.type](command.input, db)
            : stateBootstrapReadOperations[command.type](command.input, db)),
        }),
        databasePath,
        source.location,
      ),
    );
  }
  if (command.type !== "gatewayOwnerLease.read") {
    throw new Error(`Unexpected fixture read: ${command.type}`);
  }
  const lease = withEngineStoreAdmission(() =>
    inspectGatewayOwnerLease({ ...source, databasePath }, () => {}, command.schemaMaintenance),
  );
  return { ok: true as const, type: command.type, sourceAdmitted: true as const, lease };
}

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterAll);

const step = (version: number) =>
  agentEngineSchema.postgresMigrations!.find((migration) => migration.version === version)!;
type Predecessor = ReturnType<typeof step>["fromSchema"];
/** A historical layout; search versions it omits stay historical instead of inheriting current. */
const historical = (from: Predecessor, version: number): StoreSchema => ({
  ...agentEngineSchema,
  ...from,
  postgresVectorDecoderVersion: from.postgresVectorDecoderVersion,
  postgresVectorSearchVersion: from.postgresVectorSearchVersion,
  postgresTextSearchVersion: from.postgresTextSearchVersion,
  version,
  postgresMigrations: [],
});
// Upstream's 40 is the predecessor of its own step 41; authority (42) follows that step.
const upstream40 = step(AGENT_ACTIVE_EVENT_FACTS_SCHEMA_VERSION).fromSchema;

describe.skipIf(!connection)("Doctor PostgreSQL export of agent schemas 39 and 40", () => {
  // A private database: the scratch-schema checks below see no other suite's restores.
  const database = `doctor_authority_${randomUUID().replaceAll("-", "")}`;
  const isolated = new URL(connection ?? "postgresql://unused");
  isolated.pathname = `/${database}`;
  const admin = new Client({ connectionString: connection });
  const client = new Client({ connectionString: isolated.href });
  const namespaces = new Set<string>();
  const input = { connection: isolated.href, schemaPrefix: "authority_backup" };
  const config = { database: { engine: "postgres" as const, postgres: input } };
  let env: NodeJS.ProcessEnv;
  let statePath: string;
  let referenceCatalog: string[];
  const rows = async <T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) =>
    (await client.query<T>(sql, values)).rows;

  /** Bootstrap and seal a layout the way the binary that owned it did. */
  function install(schema: StoreSchema, anchorPath: string, existingOnly = false) {
    return withEngineStoreAdmission(() => {
      using anchor = openNodeSqliteDatabase(anchorPath);
      const db = openEngineStore({
        anchor,
        schema,
        input,
        inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: existingOnly }),
        prepareAnchor() {},
        openSqlite() {
          throw new Error("Expected PostgreSQL");
        },
        existingOnly,
      });
      try {
        const facts = getPostgresPhysicalFacts(db)!;
        namespaces.add(facts.namespace);
        return facts;
      } finally {
        db.close();
      }
    });
  }

  // Namespace-qualified definitions are relocated so separate stores compare; the catalog query
  // does not order its aggregate, so facts compare sorted.
  async function catalog(namespace: string) {
    return readPostgresCatalog((await rows(postgresCatalogQuery(namespace, true)))[0]!.catalog)
      .filter((fact) => fact.table !== "openclaw_schema_meta")
      .map((fact) => JSON.stringify(fact).replaceAll(namespace, "fixture_namespace"))
      .toSorted();
  }

  /** Every row of every table, the catalog, and each relation's storage identity. */
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
      relations: await rows(
        `SELECT c.relname AS name, c.oid::text AS oid, c.relfilenode::text AS filenode
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 ORDER BY c.relname`,
        [namespace],
      ),
    };
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
    return { statements, [Symbol.dispose]: () => observation.unsubscribe(observe) };
  }

  /** A populated agent store at `from`, registered where Doctor discovers it. */
  async function agentStore(name: string, from: Predecessor, version: number) {
    const agentPath = path.join(
      env.OPENCLAW_STATE_DIR!,
      name,
      "agents/main/agent/openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    const { namespace } = install(historical(from, version), agentPath);
    const message = (id: string, parentId: string | null, text: string) =>
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: "2026-10-16T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text }] },
      });
    await client.query(`
      INSERT INTO "${namespace}".schema_meta VALUES ('primary', 'agent', ${version}, 'main', NULL, 1, 1);
      INSERT INTO "${namespace}".session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0);
      INSERT INTO "${namespace}".memory_index_state (id, revision) VALUES (1, 0);
      INSERT INTO "${namespace}".session_nodes (session_key, current_session_id, entry_json, updated_at)
        VALUES ('agent:main:main', 'session', '{"sessionId":"session"}', 1);
      INSERT INTO "${namespace}".session_windows
        (session_id, session_key, created_at, updated_at, transcript_updated_at)
        VALUES ('session', 'agent:main:main', 1, 1, 1);
      INSERT INTO "${namespace}".cache_entries (scope, key, value_json, updated_at)
        VALUES ('fixture', 'retained', '"before"', 1);
    `);
    // PostgreSQL stores each event's predicate facts, as its transcript writer does.
    for (const [seq, event] of [
      message("first", null, "the fix to server.py landed"),
      message("second", "first", "recipient authority survives the export"),
    ].entries()) {
      const facts = deriveTranscriptPredicateFields(event);
      await client.query(
        `INSERT INTO "${namespace}".transcript_events (session_id, seq, event_json, created_at,
          navigation_type, navigation_custom_type, navigation_display, message_role,
          navigation_last_type, navigation_last_custom_type, navigation_valid)
         VALUES ('session', $1, $2, $1, $3, $4, $5, $6, $7, $8, $9)`,
        [
          seq + 1,
          event,
          facts.navigation_type,
          facts.navigation_custom_type,
          facts.navigation_display,
          facts.message_role,
          facts.navigation_last_type,
          facts.navigation_last_custom_type,
          facts.navigation_valid,
        ],
      );
    }
    await client.query(`INSERT INTO "${namespace}".transcript_event_identities
      (session_id, event_id, seq, event_type, message_idempotency_key, created_at)
      VALUES ('session', 'first', 1, 'message', 'first', 1),
        ('session', 'second', 2, 'message', 'second', 2);
      INSERT INTO "${namespace}".session_transcript_active_events
        (session_id, active_position, event_seq, message_position, context_eligible)
        VALUES ('session', 0, 1, 0, 1), ('session', 1, 2, 1, 1);
      INSERT INTO "${namespace}".session_transcript_index_state (session_id, indexed_seq,
        leaf_event_id, needs_rebuild, active_event_count, active_message_count, updated_at)
        VALUES ('session', 2, 'second', 0, 2, 2, 1)`);
    // The transcript owner's projection, exactly what the runtime and the port rebuild derive.
    await client.query(`SET search_path = "${namespace}"`);
    try {
      await rebuildAgentPortProjections({ engine: "postgres", db: client, namespace });
    } finally {
      await client.query("RESET search_path");
    }
    {
      using anchor = openNodeSqliteDatabase(agentPath);
      publishSqliteDatabaseSchemaChange(anchor);
    }
    withEngineStoreAdmission(() =>
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          db.prepare(`INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at)
            VALUES ('main', ?, ?, 1)`).run(agentPath, version);
        },
        { env },
      ),
    );
    closeOpenClawStateDatabaseForTest();
    return { agentPath, namespace };
  }

  async function runDoctor(agentPath: string, foundVersion: number) {
    const lock = await acquireGatewayLock({
      env,
      allowInTests: true,
      role: "sqlite-maintenance",
      timeoutMs: 0,
    });
    expect(lock).not.toBeNull();
    try {
      return await lock!.run(() =>
        prepareDoctorDatabaseMigrations({
          env,
          pendingDatabasePaths: [agentPath],
          databasePaths: [statePath, agentPath],
          agentDatabaseTargets: [
            { agentId: "main", path: agentPath, realPath: agentPath, source: "registry" },
          ],
          pendingMigrations: [
            {
              kind: "agent",
              path: agentPath,
              foundVersion,
              supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
            },
          ],
        }),
      );
    } finally {
      closeOpenClawStateDatabaseForTest();
      await lock!.release();
    }
  }

  // Upstream's 39 widens the transcript payload CHECK; its 38 still holds the prior one.
  const widenedPayload = async (namespace: string) =>
    (
      await rows<{ widened: boolean }>(
        `SELECT bool_or(pg_get_constraintdef(c.oid) LIKE '%(event_json IS NULL) AND (event_zstd IS NULL)%')
           AS widened FROM pg_constraint c
         JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace
         WHERE n.nspname = $1 AND r.relname = 'transcript_events' AND c.contype = 'c'`,
        [namespace],
      )
    )[0]!.widened;
  const backups = (agentPath: string) =>
    fs
      .readdirSync(path.dirname(agentPath))
      .filter((entry) => entry.endsWith(".postgres.bak"))
      .map((entry) => path.join(path.dirname(agentPath), entry));
  const migrationStatements = (statements: readonly string[]) =>
    statements.filter((sql) =>
      /\bUPDATE (?:openclaw_)?schema_meta\b|DROP EXPRESSION|"session_recipient_authority"/u.test(
        sql,
      ),
    );
  // Verification and restore scratch schemas a failed export must not leave behind.
  const scratchNamespaces = () =>
    rows(`SELECT nspname FROM pg_namespace
      WHERE nspname LIKE 'port\\_verify\\_%' OR nspname LIKE 'restore\\_%'
        OR nspname LIKE 'openclaw\\_check\\_%' ORDER BY nspname`);

  beforeAll(async () => {
    const worker = await vi.importActual<typeof StateReadWorker>(
      "../../state/openclaw-state-read-worker.js",
    );
    reads.retire.mockImplementation(worker.retireIdleOpenClawStateReadWorkers);
    reads.capture.mockImplementation(() => ({
      own: () => () => {},
      createTransport: (command) =>
        createMockStateReadSource({
          read: async (source) => ({ value: await readInProcess(command, source) }),
          async close() {},
        }).createTransport(command),
    }));
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    await client.connect();
    await client.query(
      "CREATE EXTENSION unaccent; CREATE EXTENSION pg_trgm; CREATE EXTENSION vector",
    );
    installDatabaseProcessRole("cli-oneshot");
    env = { ...process.env, OPENCLAW_STATE_DIR: dirs.make("doctor-pg-authority-") };
    statePath = resolveOpenClawStateSqlitePath(env);
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: input,
    });
    namespaces.add(
      withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction(({ db }) => getPostgresPhysicalFacts(db)!.namespace, {
          env,
        }),
      ),
    );
    closeOpenClawStateDatabaseForTest();
    // The reference anchor stays outside Doctor's discovered inventory.
    const { namespace } = install(
      agentEngineSchema,
      path.join(dirs.make("doctor-pg-authority-reference-"), "agent.sqlite"),
    );
    referenceCatalog = await catalog(namespace);
  });

  afterAll(async () => {
    closeOpenClawStateDatabaseForTest();
    resetDatabaseEngineSelectionForTest();
    vi.restoreAllMocks();
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  });

  it("exports upstream's 40 losslessly, restores it exactly, and migrates it to 42", async () => {
    const { agentPath, namespace } = await agentStore("upstream40", upstream40, 40);
    const before = await snapshot(namespace);
    expect(before.tables.session_recipient_authority).toBeUndefined();
    expect(before.tables.session_creation_operations).toBe("[]");
    expect(await widenedPayload(namespace)).toBe(true);

    const result = await runDoctor(agentPath, 40);
    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      `Upgraded agent database schema in ${agentPath}: v40 -> v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
    );

    // Lossless export: the exact image carries every transcript row and the transcript search.
    const [directory, ...extra] = backups(agentPath);
    expect(extra).toEqual([]);
    expect(result.changes).toContain(`Saved pre-migration PostgreSQL backup: ${directory}`);
    const manifest = await verifyMatchedPostgresBackup(directory!, "exact");
    expect(manifest.source).toMatchObject({ owner: "agent", schemaVersion: 40, namespace });
    expect(manifest.verification.tables.session_recipient_authority).toBeUndefined();
    expect(manifest.verification.tables.transcript_events?.rows).toBe(2);
    {
      using image = openNodeSqliteDatabase(path.join(directory!, "database.sqlite"), {
        readOnly: true,
      });
      expect(image.prepare("PRAGMA user_version").get()).toEqual({ user_version: 40 });
      expect(
        image
          .prepare(
            "SELECT message_id FROM session_transcript_fts WHERE session_transcript_fts MATCH 'server' ORDER BY message_id",
          )
          .all(),
      ).toEqual([{ message_id: "first" }]);
    }

    // Doctor then migrated the store in place: rows kept, only the empty authority table added.
    const after = await snapshot(namespace);
    expect(after.catalog).toEqual(referenceCatalog);
    expect(after.tables.session_recipient_authority).toBe("[]");
    expect(after.tables.session_creation_operations).toBe(
      before.tables.session_creation_operations,
    );
    expect(after.tables.transcript_events).toBe(before.tables.transcript_events);
    expect(after.tables.session_transcript_fts).toBe(before.tables.session_transcript_fts);
    expect(await widenedPayload(namespace)).toBe(true);
    expect(await rows(`SELECT version FROM "${namespace}".openclaw_schema_meta`)).toEqual([
      { version: String(AGENT_RECIPIENT_AUTHORITY_SCHEMA_VERSION) },
    ]);

    // Exact restore: the export rebuilds the pre-Doctor upstream 40 store.
    const restoredPath = path.join(path.dirname(agentPath), "restored.sqlite");
    const restored = await preparePostgresRestore({
      directory: directory!,
      anchorPath: restoredPath,
      config,
      profile: "exact",
      assertCurrent() {},
    });
    namespaces.add(restored.namespace);
    expect(readBackupEngine(restoredPath)).toMatchObject({ namespace: restored.namespace });
    expect(
      await rows(
        `SELECT store, version, store_id FROM "${restored.namespace}".openclaw_schema_meta`,
      ),
    ).toEqual([{ store: "agent", version: "40", store_id: manifest.source.storeId }]);
    const copy = await snapshot(restored.namespace);
    expect(copy.catalog).toEqual(before.catalog);
    const { openclaw_schema_meta: _seal, ...data } = before.tables;
    expect(copy.tables).toMatchObject(data);
    expect(Object.keys(copy.tables).toSorted()).toEqual(Object.keys(before.tables).toSorted());
    // The engine owner seals the restored copy as upstream's exact 40 layout.
    expect(install(historical(upstream40, 40), restoredPath, true)).toMatchObject({
      namespace: restored.namespace,
      version: 40,
    });
  });

  it("leaves the store unchanged and never starts the migration when its export fails", async () => {
    const { agentPath, namespace } = await agentStore("upstream40-failed", upstream40, 40);
    const anchorBytes = fs.readFileSync(agentPath);
    const before = await snapshot(namespace);
    const scratch = await scratchNamespaces();
    injected.failOnTable = "transcript_events";
    try {
      using observation = observeStatements();
      await expect(runDoctor(agentPath, 40)).rejects.toThrow(
        "Injected export failure while copying transcript_events",
      );
      expect(migrationStatements(observation.statements)).toEqual([]);
    } finally {
      injected.failOnTable = undefined;
    }
    expect(await snapshot(namespace)).toEqual(before);
    expect(fs.readFileSync(agentPath)).toEqual(anchorBytes);
    expect(await scratchNamespaces()).toEqual(scratch);
    // The incomplete capture is never a restorable backup.
    for (const directory of backups(agentPath)) {
      await expect(verifyMatchedPostgresBackup(directory, "exact")).rejects.toThrow(
        "PostgreSQL backup is incomplete.",
      );
    }
  });

  // The declared layout still serves upstream's own 39: no authority table, the widened CHECK.
  it("still exports upstream's own schema-39 store with its declared layout", async () => {
    const { agentPath, namespace } = await agentStore("upstream39", step(40).fromSchema, 39);
    const { changes } = await backupDoctorPostgresMigration(agentPath, input, {
      assertAdmission() {},
    });
    const [directory, ...extra] = backups(agentPath);
    expect(extra).toEqual([]);
    expect(changes).toEqual([`Saved pre-migration PostgreSQL backup: ${directory}`]);
    const manifest = await verifyMatchedPostgresBackup(directory!, "exact");
    expect(manifest.source).toMatchObject({ schemaVersion: 39, namespace });
    expect(manifest.verification.tables.session_recipient_authority).toBeUndefined();
    expect(manifest.verification.tables.transcript_events?.rows).toBe(2);
    const restored = await preparePostgresRestore({
      directory: directory!,
      anchorPath: path.join(path.dirname(agentPath), "restored.sqlite"),
      config,
      profile: "exact",
      assertCurrent() {},
    });
    namespaces.add(restored.namespace);
    expect(await catalog(restored.namespace)).toEqual(await catalog(namespace));
  });
});
