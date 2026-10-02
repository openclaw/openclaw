import type { DatabaseSync } from "node:sqlite";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import { setConfiguredMcpServer } from "../agents/mcp-config-mutation.js";
import { withClawMcpLifecycleLease } from "../agents/mcp-lifecycle-lease.js";
import { canonicalizeConfiguredMcpServer } from "../config/mcp-config-normalize.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import {
  compileSqliteQueryBindings,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  persistClawMcpPendingRefForAdd,
  readClawMcpServerRefsByNameForAdd,
  updateClawMcpRefForAdd,
  type ClawAddStateOptions,
} from "./add-state-write.js";
import { digestClawValue } from "./digest.js";
import {
  CLAW_MCP_REF_SCHEMA_VERSION,
  refToRow,
  rowToRef,
  selectMcpRefs,
  type McpDatabase,
  type McpRefRow,
  type PersistedClawMcpServerRef,
} from "./mcp-records.js";
import type { ClawReferencedCleanup } from "./package-remove.js";
import { reconcileClawMcpServerRefsInWorker } from "./provenance-write.js";
import type { ClawAddPlan, ClawMcpServer } from "./types.js";

export { CLAW_MCP_REF_SCHEMA_VERSION, type PersistedClawMcpServerRef } from "./mcp-records.js";

export class ClawMcpInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly mcpServers: PersistedClawMcpServerRef[],
  ) {
    super(message);
    this.name = "ClawMcpInstallError";
  }
}

function mcpServerFromActionDetails(details: Record<string, unknown>): ClawMcpServer | undefined {
  const { expectedState: _expectedState, prerequisites: _prerequisites, ...server } = details;
  return "command" in server || "url" in server ? (server as ClawMcpServer) : undefined;
}

export function digestClawMcpServer(server: Record<string, unknown>): string {
  return digestClawValue(canonicalizeConfiguredMcpServer(server));
}

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

export async function installClawMcpServers(
  plan: ClawAddPlan,
  options: ClawAddStateOptions & {
    setMcpServer?: (params: {
      name: string;
      server: ClawMcpServer;
      createOnly?: boolean;
    }) => ReturnType<typeof setConfiguredMcpServer>;
    listMcpServers?: typeof listConfiguredMcpServers;
    nowMs?: number;
  } = {},
): Promise<PersistedClawMcpServerRef[]> {
  const setMcpServer = options.setMcpServer ?? setConfiguredMcpServer;
  const listMcpServers = options.listMcpServers ?? listConfiguredMcpServers;
  const refs: PersistedClawMcpServerRef[] = [];
  for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
    await withClawMcpLifecycleLease(action.id, options, async (assertOwned) => {
      const assertCurrent = () => {
        assertOwned();
        options.assertCurrent?.();
      };
      const stateOptions = { ...options, assertCurrent };
      const server = action.details ? mcpServerFromActionDetails(action.details) : undefined;
      if (!server) {
        throw new ClawMcpInstallError(
          "mcp_plan_invalid",
          `MCP server action ${JSON.stringify(action.id)} is invalid.`,
          refs,
        );
      }
      const listed = await listMcpServers();
      assertCurrent();
      if (!listed.ok) {
        throw new ClawMcpInstallError("mcp_preflight_failed", listed.error, refs);
      }
      const configured = listed.mcpServers[action.id];
      const configDigest = digestClawMcpServer(server);
      if (configured && digestClawMcpServer(configured) !== configDigest) {
        throw new ClawMcpInstallError(
          "mcp_config_conflict",
          `MCP server ${JSON.stringify(action.id)} already exists with different configuration.`,
          refs,
        );
      }
      const existingRefs = await readClawMcpServerRefsByNameForAdd(action.id, stateOptions);
      const inheritsClawOrigin =
        existingRefs.length > 0 &&
        existingRefs.every(
          (candidate) => candidate.origin === "claw-introduced" && !candidate.independentOwner,
        );
      const ownership = configured
        ? {
            relationship: "referenced" as const,
            origin: inheritsClawOrigin ? ("claw-introduced" as const) : ("pre-existing" as const),
            independentOwner: !inheritsClawOrigin,
          }
        : {
            relationship: "managed" as const,
            origin: "claw-introduced" as const,
            independentOwner: false,
          };
      let pending = await persistClawMcpPendingRefForAdd(
        plan,
        action.id,
        server,
        ownership,
        stateOptions,
      );
      refs.push(pending);
      if (pending.status === "complete") {
        if (configured) {
          return;
        }
        const hasSiblingOwner = (
          await readClawMcpServerRefsByNameForAdd(action.id, stateOptions)
        ).some((candidate) => candidate.agentId !== plan.agent.finalId);
        if (
          pending.relationship !== "managed" ||
          pending.origin !== "claw-introduced" ||
          pending.independentOwner ||
          hasSiblingOwner
        ) {
          throw new ClawMcpInstallError(
            "mcp_reconcile_conflict",
            `MCP server ${JSON.stringify(action.id)} was removed while shared or independently owned and will not be recreated.`,
            refs,
          );
        }
        pending = await updateClawMcpRefForAdd(pending, { status: "pending" }, stateOptions);
        refs[refs.length - 1] = pending;
      }
      if (configured) {
        refs[refs.length - 1] = await updateClawMcpRefForAdd(
          pending,
          { status: "complete" },
          stateOptions,
        );
        return;
      }
      let result: Awaited<ReturnType<typeof setConfiguredMcpServer>>;
      try {
        result = await setMcpServer({
          name: action.id,
          server,
          createOnly: true,
          recordIndependentOwner: false,
          assertCurrent,
        });
      } catch (error) {
        const message = coerceErrorMessage(error);
        throw new ClawMcpInstallError("mcp_install_uncertain", message, refs);
      }
      if (!result.ok) {
        refs[refs.length - 1] = await updateClawMcpRefForAdd(
          pending,
          { status: "failed", error: result.error },
          stateOptions,
        );
        throw new ClawMcpInstallError("mcp_install_failed", result.error, refs);
      }
      try {
        refs[refs.length - 1] = await updateClawMcpRefForAdd(
          pending,
          { status: "complete" },
          stateOptions,
        );
      } catch (error) {
        const message = coerceErrorMessage(error);
        throw new ClawMcpInstallError(
          "mcp_provenance_failed",
          `MCP server was configured, but ownership could not be persisted: ${message}`,
          refs,
        );
      }
    });
  }
  return refs;
}

export function readClawMcpServerRefs(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawMcpServerRef[] {
  return readClawMcpServerRefsInDatabase(
    openOpenClawStateDatabase(options).db,
    agentId,
    options.readOnly,
  );
}

export function readClawMcpServerRefsInDatabase(
  db: DatabaseSync,
  agentId: string,
  readOnly = false,
): PersistedClawMcpServerRef[] {
  if (readOnly && !tableExists(db, "claw_mcp_server_refs")) {
    return [];
  }
  const { compiled, bind } = compileSqliteQueryBindings<string>((parameter) =>
    selectMcpRefs(db)
      .where(
        "agent_id",
        "=",
        parameter((value) => value),
      )
      .orderBy("name"),
  );
  const rows =
    db /* sqlite-allow-raw: preserve native full-agent inventory errors without a write transaction. */
      .prepare(compiled.sql)
      // SAFETY: The canonical table and explicit projection provide this generated row shape.
      .all(...bind(agentId)) as McpRefRow[];
  return rows.map(rowToRef);
}

export function readAllClawMcpServerRefsInDatabase(db: DatabaseSync): PersistedClawMcpServerRef[] {
  if (!tableExists(db, "claw_mcp_server_refs")) {
    return [];
  }
  const query = selectMcpRefs(db).orderBy("agent_id").orderBy("name").compile();
  const rows = db /* sqlite-allow-raw: read-only Claw MCP reference inventory. */
    .prepare(query.sql)
    // SAFETY: the query projects every persisted Claw MCP reference column.
    .all() as McpRefRow[];
  return rows.map(rowToRef);
}

export function readClawMcpServerRefsByName(
  name: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawMcpServerRef[] {
  const { db } = openOpenClawStateDatabase(options);
  if (options.readOnly && !tableExists(db, "claw_mcp_server_refs")) {
    return [];
  }
  const { compiled, bind } = compileSqliteQueryBindings<string>((parameter) =>
    selectMcpRefs(db)
      .where(
        "name",
        "=",
        parameter((value) => value),
      )
      .orderBy("agent_id"),
  );
  const rows =
    db /* sqlite-allow-raw: preserve native sibling-inventory errors without a write transaction. */
      .prepare(compiled.sql)
      // SAFETY: The canonical table and explicit projection provide this generated row shape.
      .all(...bind(name)) as McpRefRow[];
  return rows.map(rowToRef);
}

export function clawMcpRemovalSelector(ref: PersistedClawMcpServerRef): string {
  return `mcp:${ref.name}`;
}

type ClawMcpServerRemovalDecision = {
  ref: PersistedClawMcpServerRef;
  action: "remove" | "release";
  blocked: boolean;
  affectedClawAgentIds: string[];
  reason?: string;
};

export function planClawMcpServerRemoval(
  ref: PersistedClawMcpServerRef,
  options: OpenClawStateDatabaseOptions & { referencedCleanup?: ClawReferencedCleanup } = {},
  allRefs?: readonly PersistedClawMcpServerRef[],
): ClawMcpServerRemovalDecision {
  const otherRefs = (allRefs ?? readClawMcpServerRefsByName(ref.name, options)).filter(
    (candidate) => candidate.name === ref.name && candidate.agentId !== ref.agentId,
  );
  const affectedClawAgentIds = otherRefs.map((candidate) => candidate.agentId).toSorted();
  const cleanup = options.referencedCleanup ?? { mode: "retain" };
  const explicitlySelected =
    cleanup.mode === "remove-selected" &&
    (cleanup.selected ?? []).includes(clawMcpRemovalSelector(ref));
  const conflicts =
    affectedClawAgentIds.length > 0 || ref.independentOwner || ref.origin === "pre-existing";
  const release = (reason: string, blocked = false): ClawMcpServerRemovalDecision => ({
    ref,
    action: "release",
    blocked,
    affectedClawAgentIds,
    reason,
  });

  if (ref.relationship === "managed") {
    if (explicitlySelected) {
      return release(
        "--remove-referenced only accepts resources with a referenced relationship.",
        true,
      );
    }
    if (affectedClawAgentIds.length > 0) {
      return release("Another Claw still references this MCP server.");
    }
    if (ref.independentOwner) {
      return release("MCP server has a current non-Claw owner.");
    }
    return { ref, action: "remove", blocked: false, affectedClawAgentIds };
  }
  if (!explicitlySelected && cleanup.mode !== "remove-if-unused") {
    return release("Referenced resources are retained unless a cleanup mode selects them.");
  }
  if (!explicitlySelected && conflicts) {
    return release(
      affectedClawAgentIds.length > 0
        ? "Another Claw still references this MCP server."
        : "MCP server has a current non-Claw owner or pre-existing origin.",
    );
  }
  if (explicitlySelected && conflicts && !cleanup.allowConflicts) {
    return release(
      "Selected MCP server has other Claw dependents, a non-Claw owner, or pre-existing origin; explicit conflict override is required.",
      true,
    );
  }
  return { ref, action: "remove", blocked: false, affectedClawAgentIds };
}

export function reconcileClawMcpServerRefs(
  agentId: string,
  configuredServers: Record<string, Record<string, unknown>>,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): Promise<PersistedClawMcpServerRef[]> {
  return reconcileClawMcpServerRefsInWorker(
    agentId,
    Object.fromEntries(
      Object.entries(configuredServers).map(([name, server]) => [
        name,
        digestClawMcpServer(server),
      ]),
    ),
    options,
  );
}

export function deleteClawMcpServerRef(
  agentId: string,
  name: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<McpDatabase>(db)
        .deleteFrom("claw_mcp_server_refs")
        .where("agent_id", "=", agentId)
        .where("name", "=", name),
    );
  }, options);
}

export function upsertClawMcpServerRef(
  ref: PersistedClawMcpServerRef,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<McpDatabase>(db)
        .insertInto("claw_mcp_server_refs")
        .values(refToRow(ref))
        .onConflict((conflict) =>
          conflict.columns(["agent_id", "name"]).doUpdateSet((eb) => ({
            schema_version: eb.ref("excluded.schema_version"),
            config_digest: eb.ref("excluded.config_digest"),
            relationship: eb.ref("excluded.relationship"),
            origin: eb.ref("excluded.origin"),
            independent_owner: eb.ref("excluded.independent_owner"),
            status: eb.ref("excluded.status"),
            error: eb.ref("excluded.error"),
            // Existing claims retain their original creation timestamp through updates and undo.
            updated_at_ms: eb.ref("excluded.updated_at_ms"),
          })),
        ),
    );
  }, options);
}
