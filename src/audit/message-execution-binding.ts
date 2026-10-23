import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
/** Exact execution binding for owner-native outbound message lifecycle facts. */
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { ensureStatePostgresFragment } from "../state/openclaw-state-db-engine.js";
import { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { getOpenClawStateFeatureSchemaSql } from "../state/openclaw-state-feature-schema.js";
import {
  parseExecutionIdentityAdmissionToken,
  type ExecutionIdentityAdmissionToken,
} from "./execution-identity-admission.js";

type ExecutionBindingDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "execution_identity_contexts" | "outbound_message_execution_bindings"
>;
const ensuredTerminalBindingDatabases = new WeakSet<EngineConnection>();

export type MessageExecutionBinding = Readonly<{
  contextId: string;
  executionId: string;
}>;

export function selectMessageExecutionBinding(params: {
  contextId?: string;
  executionId?: string;
}): MessageExecutionBinding | undefined {
  if (params.contextId === undefined && params.executionId === undefined) {
    return undefined;
  }
  if (!params.contextId || !params.executionId) {
    throw new Error("outbound message decision query requires the exact context and execution");
  }
  return { contextId: params.contextId, executionId: params.executionId };
}

export function hasMessageExecutionBindingColumns(
  db: EngineConnection,
  tableName: "outbound_message_progress",
): boolean {
  return (
    tableHasColumn(db, tableName, "context_id") && tableHasColumn(db, tableName, "execution_id")
  );
}

function terminalBindingSchemaSql(): string {
  return getOpenClawStateFeatureSchemaSql("outbound_message_execution_bindings", {
    endMarker:
      "  ON outbound_message_execution_bindings (context_id, execution_id, run_id, event_id);",
    errorMessage: "canonical outbound message execution binding schema is missing",
  });
}

const ensureTerminalBindingSchema = createSqliteSchemaEnsurer(terminalBindingSchemaSql, {
  tables: ["outbound_message_execution_bindings"],
  indexes: ["outbound_message_execution_bindings_execution_event_idx"],
});

/** Install the terminal binding companion only when an exact producer first uses it. */
export function ensureTerminalMessageExecutionBindingSchema(
  options: OpenClawStateDatabaseOptions,
): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredTerminalBindingDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (isPostgresSqlConnection(db)) {
        ensureStatePostgresFragment(db, "outbound_message_execution_bindings");
      } else {
        ensureTerminalBindingSchema(db);
      }
    },
    { ...options, database },
    { operationLabel: "audit.outbound-message.execution-binding.schema.ensure" },
  );
  ensuredTerminalBindingDatabases.add(database.db);
}

/** Validate queue-loaded token bytes before entering a synchronous write transaction. */
export function planMessageExecutionBinding(
  token: ExecutionIdentityAdmissionToken | undefined,
  runId: string | undefined,
): ExecutionIdentityAdmissionToken | undefined {
  if (!token) {
    return undefined;
  }
  const planned = parseExecutionIdentityAdmissionToken(token);
  if (!runId || planned.runId !== runId) {
    throw new Error("outbound message execution binding disagrees with the admitted run");
  }
  return planned;
}

/** Confirm the exact retained admission row; run correlation alone never binds a receipt. */
export function confirmMessageExecutionBinding(
  db: EngineConnection,
  token: ExecutionIdentityAdmissionToken | undefined,
): MessageExecutionBinding | undefined {
  if (!token || !tableExists(db, "execution_identity_contexts")) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<ExecutionBindingDatabase>(db)
      .selectFrom("execution_identity_contexts")
      .select("context_id")
      .where("context_id", "=", token.contextId)
      .where("execution_id", "=", token.executionId)
      .where("run_id", "=", token.runId)
      .where("created_at", "=", token.createdAt),
  );
  return row ? { contextId: token.contextId, executionId: token.executionId } : undefined;
}

function recordTerminalMessageExecutionBinding(
  db: EngineConnection,
  params: MessageExecutionBinding & { eventId: string; runId: string },
): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<ExecutionBindingDatabase>(db)
      .insertInto("outbound_message_execution_bindings")
      .values({
        event_id: params.eventId,
        context_id: params.contextId,
        execution_id: params.executionId,
        run_id: params.runId,
      }),
  );
}

export function recordConfirmedTerminalMessageExecutionBinding(
  db: EngineConnection,
  params: { eventId: string | undefined; token?: ExecutionIdentityAdmissionToken },
): void {
  if (!params.eventId) {
    return;
  }
  const binding = confirmMessageExecutionBinding(db, params.token);
  if (binding && params.token) {
    recordTerminalMessageExecutionBinding(db, {
      eventId: params.eventId,
      runId: params.token.runId,
      ...binding,
    });
  }
}
