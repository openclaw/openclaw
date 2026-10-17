import {
  compileSqliteQueryBindings,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  CLAW_MCP_REF_SCHEMA_VERSION,
  refToRow,
  rowToRef,
  selectMcpRefs,
  type McpDatabase,
  type McpRefRow,
  type PersistedClawMcpServerRef,
} from "./mcp-records.js";
import { ClawMcpInstallError, digestClawMcpServer } from "./mcp.js";
import type { ClawAddPlan, ClawMcpServer } from "./types.js";

export function persistClawMcpPendingRef(
  plan: ClawAddPlan,
  name: string,
  server: ClawMcpServer,
  ownership: Pick<PersistedClawMcpServerRef, "relationship" | "origin" | "independentOwner">,
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawMcpServerRef {
  const nowMs = options.nowMs ?? Date.now();
  const configDigest = digestClawMcpServer(server);
  const database = openOpenClawStateDatabase(options);
  const { compiled, bind } = compileSqliteQueryBindings<{ agentId: string; name: string }>(
    (parameter) =>
      selectMcpRefs(database.db)
        .where(
          "agent_id",
          "=",
          parameter((value) => value.agentId),
        )
        .where(
          "name",
          "=",
          parameter((value) => value.name),
        ),
  );
  const existing =
    database.db /* sqlite-allow-raw: preserve native point-read errors outside the write transaction. */
      .prepare(compiled.sql)
      // SAFETY: The canonical table and explicit projection provide this generated row shape.
      .get(...bind({ agentId: plan.agent.finalId, name })) as McpRefRow | undefined;
  if (existing) {
    const ref = rowToRef(existing);
    if (ref.configDigest !== configDigest || ref.status === "failed") {
      throw new ClawMcpInstallError(
        "mcp_provenance_conflict",
        `MCP server ${JSON.stringify(name)} differs from its ownership record.`,
        [ref],
      );
    }
    return ref;
  }
  const ref: PersistedClawMcpServerRef = {
    schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
    agentId: plan.agent.finalId,
    name,
    configDigest,
    ...ownership,
    status: "pending",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<McpDatabase>(db).insertInto("claw_mcp_server_refs").values(refToRow(ref)),
    );
  }, options);
  return ref;
}

export function updateClawMcpRef(
  ref: PersistedClawMcpServerRef,
  update: { status: PersistedClawMcpServerRef["status"]; error?: string },
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawMcpServerRef {
  const updated = { ...ref, ...update, updatedAtMs: options.nowMs ?? Date.now() };
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<McpDatabase>(db)
        .updateTable("claw_mcp_server_refs")
        .set({
          status: update.status,
          error: update.error ?? null,
          updated_at_ms: updated.updatedAtMs,
        })
        .where("agent_id", "=", ref.agentId)
        .where("name", "=", ref.name),
    );
  }, options);
  return updated;
}
