import { getEnvironmentData } from "node:worker_threads";
import {
  getDatabaseEngineInput,
  getDatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import type { PostgresSchemaFragment, StoreSchema } from "../infra/database-engine/contract.js";
import { openEngineStore } from "../infra/database-engine/open.js";
import {
  admitPostgresPhysicalFacts,
  getPostgresPhysicalFacts,
  requireNativeDatabaseFile,
} from "../infra/database-engine/physical-facts.js";
import { assertPostgresCatalog } from "../infra/database-engine/postgres-catalog.js";
import { isPostgresSqlConnection, type PostgresSqlConnection } from "../infra/sql-connection.js";
import {
  invalidateLocalSqliteSchemaAdmissions,
  publishSqliteDatabaseSchemaChange,
} from "../infra/sqlite-database-admission.js";
import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-lifecycle-errors.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { captureSqliteSchemaFacts } from "../infra/sqlite-schema-admission.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { VERSION } from "../version.js";
import {
  getStateRuntimeSchemaAdmission,
  publishStateRuntimeSchemaAdmission,
  publishStateSchemaVersionAdmission,
} from "./openclaw-state-db-admission.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { openTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { admitStateSchemaFacts } from "./openclaw-state-db-schema-version.js";
import { writeStateSchemaContentVersion } from "./openclaw-state-schema-publication.js";
import { statePostgresRuntime as runtime } from "./postgres-schema.generated/runtime.js";

const recovery =
  "Use the matching OpenClaw version or restore the matching PostgreSQL schema and anchor.";

export function stateEngineInput() {
  const selected = getDatabaseEngineSelection();
  if (selected) {
    return getDatabaseEngineInput("state");
  }
  const connection: unknown =
    process.env.NODE_ENV === "test"
      ? getEnvironmentData("openclaw.test.state.connection")
      : undefined;
  return typeof connection === "string" ? { connection, schemaPrefix: "openclaw_test" } : undefined;
}

export function isStatePostgres(): boolean {
  return stateEngineInput() !== undefined;
}

export function assertStateFileSnapshotAllowed(): void {
  if (stateEngineInput()) {
    requireNativeDatabaseFile("postgres", "file-snapshot");
  }
}

export function inspectStateSqlite(db: Parameters<typeof openEngineStore>[0]["anchor"]) {
  // Dynamic authorizers cannot reuse admitted facts; capture through their current policy.
  const facts = getAdmittedSqliteSchemaFacts(db) ?? captureSqliteSchemaFacts(db);
  return {
    hasEngineAnchor: facts.tables.has("openclaw_engine_anchor"),
    hasExistingData: [...facts.tables, ...facts.views, ...facts.triggers.keys()].some(
      (name) => name !== "openclaw_engine_anchor" && !name.startsWith("sqlite_"),
    ),
  };
}

export function admitStatePostgres(db: PostgresSqlConnection, fresh: boolean): void {
  if (!fresh && getStateRuntimeSchemaAdmission(db)?.startupReady) {
    return;
  }
  const facts = getPostgresPhysicalFacts(db);
  if (!facts) {
    throw new Error(`Missing PostgreSQL state admission. ${recovery}`);
  }
  const tables = new Set(
    facts.catalog.filter((fact) => fact.kind === "table").map((fact) => fact.table),
  );
  const absent = new Set(
    runtime.fragments.flatMap((fragment) =>
      fragment.tables.some((table) => tables.has(table)) ? [] : fragment.tables,
    ),
  );
  // Older inspection schemas are checked against their migration's exact source DDL.
  if (facts.version === OPENCLAW_STATE_SCHEMA_VERSION) {
    assertPostgresCatalog(
      facts.catalog.filter(
        (fact) => !fact.kind.endsWith("Definition") && fact.table !== "openclaw_schema_meta",
      ),
      runtime.expectedCatalog.filter((fact) => !absent.has(fact.table)),
    );
  }
  if (fresh) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO schema_meta
        (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
        VALUES ('primary', 'global', ?, NULL, ?, ?, ?)`,
    ).run(OPENCLAW_STATE_SCHEMA_VERSION, VERSION, now, now);
    writeStateSchemaContentVersion(db);
  }
  const meta = db
    .prepare("SELECT schema_version, role, agent_id FROM schema_meta WHERE meta_key = 'primary'")
    .get();
  const content = db
    .prepare(
      "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
    )
    .get();
  // SQLite may publish the current header without a redundant content-version row.
  if (
    meta?.schema_version !== facts.version ||
    meta.role !== "global" ||
    meta.agent_id !== null ||
    (content !== undefined && content.value_json !== String(facts.version))
  ) {
    throw new Error(`PostgreSQL state metadata mismatch. ${recovery}`);
  }
  publishStateSchemaVersionAdmission(db, {
    userVersion: facts.version,
    contentVersion: facts.version,
  });
  publishStateRuntimeSchemaAdmission(db, true);
}

const statePostgresSchema = {
  postgres: runtime.eagerSql,
  postgresFragments: runtime.fragments.map((fragment): PostgresSchemaFragment => {
    const { activation } = fragment;
    if (activation !== "first-use" && activation !== "version-additive") {
      throw new Error(`Unknown PostgreSQL state fragment activation: ${activation}`);
    }
    return {
      id: fragment.id,
      tables: fragment.tables,
      sql: fragment.sql,
      dependencies: fragment.dependencies,
      activation,
    };
  }),
};

export const stateEngineSchema: StoreSchema = {
  id: "state",
  version: OPENCLAW_STATE_SCHEMA_VERSION,
  sqlite: "",
  ...statePostgresSchema,
  postgresMigrations: [
    {
      version: 25,
      sql: runtime.operatorRecoveryV25Sql,
      fromSchema: statePostgresSchema,
      schema: statePostgresSchema,
    },
    {
      version: 26,
      // WITHOUT ROWID only changes SQLite storage; PostgreSQL keeps the same catalog.
      fromSchema: statePostgresSchema,
      schema: statePostgresSchema,
      sql: `UPDATE schema_meta
        SET schema_version = 26,
          app_version = '${VERSION.replaceAll("'", "''")}',
          updated_at = CAST(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000 AS bigint)
        WHERE meta_key = 'primary';
        INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
        VALUES ('state.schema.contentVersion', '26',
          CAST(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000 AS bigint))
        ON CONFLICT (state_key) DO UPDATE
          SET value_json = EXCLUDED.value_json, updated_at_ms = EXCLUDED.updated_at_ms;`,
    },
  ],
};

export function ensureStatePostgresFragment(db: PostgresSqlConnection, table: string): void {
  const facts = getPostgresPhysicalFacts(db);
  if (!facts) {
    throw new Error(`Missing PostgreSQL state admission. ${recovery}`);
  }
  const fragment = runtime.fragments.find((item) => item.tables.includes(table));
  if (!fragment) {
    const eager = runtime.expectedCatalog.some(
      (fact) => fact.kind === "table" && fact.table === table,
    );
    if (eager && facts.catalog.some((fact) => fact.kind === "table" && fact.table === table)) {
      return;
    }
    throw new Error(`No PostgreSQL state fragment owns ${table}`);
  }
  if (
    fragment.tables.every((name) =>
      facts.catalog.some((fact) => fact.kind === "table" && fact.table === name),
    )
  ) {
    return;
  }
  for (const id of fragment.dependencies) {
    const dependency = runtime.fragments.find((item) => item.id === id);
    if (!dependency) {
      throw new Error(`Unknown state fragment dependency ${id}`);
    }
    ensureStatePostgresFragment(db, dependency.tables[0]!);
  }
  if (
    !stageSqliteTransactionState(db, {
      stage: () => {},
      rollback: () => {},
      commit: () => publishSqliteDatabaseSchemaChange(db),
      invalidate: () => publishSqliteDatabaseSchemaChange(db),
    })
  ) {
    throw new Error("PostgreSQL state fragments require the owner's transaction");
  }
  invalidateLocalSqliteSchemaAdmissions(db);
  db.exec(fragment.sql);
  admitPostgresPhysicalFacts({
    anchor: db.anchor,
    db,
    namespace: facts.namespace,
    storeId: facts.storeId,
    store: facts.store,
    version: facts.version,
    schema: stateEngineSchema,
    recordSchema: true,
  });
  admitStatePostgres(db, false);
}

export function openExistingStatePostgresConnection(pathname: string, expectedIdentity?: string) {
  const input = stateEngineInput();
  if (!input) {
    return undefined;
  }
  const anchor = openTrackedStateDatabase(pathname, { existingOnly: true, expectedIdentity });
  let db: PostgresSqlConnection | undefined;
  try {
    admitStateSchemaFacts(anchor, pathname);
    const selected = openEngineStore({
      anchor,
      schema: stateEngineSchema,
      input,
      inspectSqlite: () => inspectStateSqlite(anchor),
      prepareAnchor: () => {},
      openSqlite: () => {},
      existingOnly: true,
      reusePostgresConnection: true,
      existingVersion: true,
      admitPostgres: admitStatePostgres,
      closeOnFailure: (connection, error) => {
        db = connection;
        throw error;
      },
    });
    if (!isPostgresSqlConnection(selected)) {
      throw new Error("Expected PostgreSQL state connection");
    }
    db = selected;
    return {
      database: { db, path: pathname },
      close() {
        throwSqliteLifecycleErrors(
          openClawStateDatabaseCache.closeUnpublishedOpenClawStateDatabaseHandle({
            db: selected,
            path: pathname,
          }),
          "PostgreSQL state connection cleanup failed.",
        );
        return !selected.isOpen && !anchor.isOpen;
      },
    };
  } catch (error) {
    const errors = openClawStateDatabaseCache.closeUnpublishedOpenClawStateDatabaseHandle({
      db: db ?? anchor,
      path: pathname,
    });
    if (errors.length) {
      throw createSqliteLifecycleAggregateError(
        [error, ...errors],
        "PostgreSQL state connection acquisition and cleanup failed.",
        error,
      );
    }
    throw error;
  }
}
