import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { allocateHostPort } from "./cell-profile.js";
import type {
  FleetCellRecord,
  FleetRegistryWriteOperations,
  ReserveFleetCellParams,
} from "./registry.types.js";

type FleetCellsTable = OpenClawStateKyselyDatabase["fleet_cells"];
type FleetCellRow = Selectable<FleetCellsTable>;
type FleetRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "fleet_cells" | "state_leases">;

const FLEET_OPERATION_LEASE_SCOPE = "fleet-cell-operation";
const FLEET_OPERATION_LEASE_TTL_MS = 5 * 60_000;

/** The live caller scope and this transaction jointly fence a queued cell mutation. */
export function assertFleetCellOperationInDatabase(
  db: DatabaseSync,
  tenantId: string,
  owner: string | undefined,
): void {
  if (owner === undefined) {
    return;
  }
  const lease = executeSqliteQueryTakeFirstSync(
    db,
    kyselyFor(db)
      .selectFrom("state_leases")
      .select("owner")
      .where("scope", "=", FLEET_OPERATION_LEASE_SCOPE)
      .where("lease_key", "=", tenantId)
      .where("owner", "=", owner)
      .where("expires_at", ">", Date.now()),
  );
  if (!lease) {
    throw new Error(`Fleet operation lease was lost for ${tenantId}.`);
  }
}

function kyselyFor(db: DatabaseSync) {
  return getNodeSqliteKysely<FleetRegistryDatabase>(db);
}

function parseRuntime(runtime: string): FleetCellRecord["runtime"] {
  if (runtime === "docker" || runtime === "podman") {
    return runtime;
  }
  throw new Error(`Unsupported fleet runtime in state database: ${runtime}`);
}

function rowToRecord(row: FleetCellRow): FleetCellRecord {
  return {
    tenantId: row.tenant_id,
    createdAtMs: row.created_at_ms,
    image: row.image,
    runtime: parseRuntime(row.runtime),
    hostPort: row.host_port,
    containerName: row.container_name,
    dataDir: row.data_dir,
  };
}

function recordToRow(record: FleetCellRecord): Insertable<FleetCellsTable> {
  return {
    tenant_id: record.tenantId,
    created_at_ms: record.createdAtMs,
    image: record.image,
    runtime: record.runtime,
    host_port: record.hostPort,
    container_name: record.containerName,
    data_dir: record.dataDir,
  };
}

export function listFleetCellsInDatabase(db: DatabaseSync): FleetCellRecord[] {
  if (!tableExists(db, "fleet_cells")) {
    return [];
  }
  const rows = executeSqliteQuerySync(
    db,
    kyselyFor(db).selectFrom("fleet_cells").selectAll().orderBy("tenant_id", "asc"),
  ).rows;
  return rows.map(rowToRecord);
}

export function getFleetCellInDatabase(
  db: DatabaseSync,
  tenantId: string,
): FleetCellRecord | undefined {
  if (!tableExists(db, "fleet_cells")) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kyselyFor(db).selectFrom("fleet_cells").selectAll().where("tenant_id", "=", tenantId),
  );
  return row ? rowToRecord(row) : undefined;
}

// The shared-state owner admits each mutation below under one write transaction.
export function reserveFleetCellInDatabase(
  db: DatabaseSync,
  params: ReserveFleetCellParams,
): FleetCellRecord {
  const kysely = kyselyFor(db);
  const existing = executeSqliteQueryTakeFirstSync(
    db,
    kysely.selectFrom("fleet_cells").select("tenant_id").where("tenant_id", "=", params.tenantId),
  );
  if (existing) {
    throw new Error(`Fleet cell already exists: ${params.tenantId}`);
  }

  const usedPorts = executeSqliteQuerySync(
    db,
    kysely.selectFrom("fleet_cells").select("host_port"),
  ).rows.map((row) => row.host_port);
  // Allocate and reserve under one write lock so concurrent creates cannot claim one port.
  const hostPort = allocateHostPort(usedPorts, params.requestedPort);
  const record: FleetCellRecord = {
    tenantId: params.tenantId,
    createdAtMs: params.createdAtMs,
    image: params.image,
    runtime: params.runtime,
    hostPort,
    containerName: params.containerName,
    dataDir: params.dataDir,
  };
  executeSqliteQuerySync(db, kysely.insertInto("fleet_cells").values(recordToRow(record)));
  return record;
}

export function updateFleetCellImageInDatabase(
  db: DatabaseSync,
  tenantId: string,
  image: string,
): void {
  const result = executeSqliteQuerySync(
    db,
    kyselyFor(db).updateTable("fleet_cells").set({ image }).where("tenant_id", "=", tenantId),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Fleet cell disappeared before its image could be updated: ${tenantId}`);
  }
}

export function acquireFleetCellOperationInDatabase(
  db: DatabaseSync,
  params: FleetRegistryWriteOperations["fleet.operation.acquire"]["input"],
): void {
  const nowMs = params.nowMs ?? Date.now();
  const expiresAt = nowMs + FLEET_OPERATION_LEASE_TTL_MS;
  const kysely = kyselyFor(db);
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("state_leases")
      .where("scope", "=", FLEET_OPERATION_LEASE_SCOPE)
      .where("lease_key", "=", params.tenantId)
      .where("expires_at", "<=", nowMs),
  );
  const existing = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("state_leases")
      .select(["expires_at", "payload_json"])
      .where("scope", "=", FLEET_OPERATION_LEASE_SCOPE)
      .where("lease_key", "=", params.tenantId),
  );
  if (existing) {
    let operation = "fleet operation";
    try {
      const payload: unknown = existing.payload_json
        ? JSON.parse(existing.payload_json)
        : undefined;
      if (
        typeof payload === "object" &&
        payload !== null &&
        "operation" in payload &&
        typeof payload.operation === "string"
      ) {
        operation = `fleet ${payload.operation}`;
      }
    } catch {
      // Busy diagnostics are best-effort; lease ownership remains authoritative.
    }
    throw new Error(
      `Another ${operation} is already running for ${params.tenantId}; retry after ${new Date(existing.expires_at ?? expiresAt).toISOString()}.`,
    );
  }
  executeSqliteQuerySync(
    db,
    kysely.insertInto("state_leases").values({
      scope: FLEET_OPERATION_LEASE_SCOPE,
      lease_key: params.tenantId,
      owner: params.owner,
      expires_at: expiresAt,
      heartbeat_at: nowMs,
      payload_json: JSON.stringify({ operation: params.operation }),
      created_at: nowMs,
      updated_at: nowMs,
    }),
  );
}

export function heartbeatFleetCellOperationInDatabase(
  db: DatabaseSync,
  params: FleetRegistryWriteOperations["fleet.operation.heartbeat"]["input"],
): void {
  const nowMs = params.nowMs ?? Date.now();
  const expiresAt = nowMs + FLEET_OPERATION_LEASE_TTL_MS;
  const result = executeSqliteQuerySync(
    db,
    kyselyFor(db)
      .updateTable("state_leases")
      .set({ expires_at: expiresAt, heartbeat_at: nowMs, updated_at: nowMs })
      .where("scope", "=", FLEET_OPERATION_LEASE_SCOPE)
      .where("lease_key", "=", params.tenantId)
      .where("owner", "=", params.owner)
      .where("expires_at", ">", nowMs),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Fleet operation lease was lost for ${params.tenantId}.`);
  }
}

export function releaseFleetCellOperationInDatabase(
  db: DatabaseSync,
  params: FleetRegistryWriteOperations["fleet.operation.release"]["input"],
): void {
  executeSqliteQuerySync(
    db,
    kyselyFor(db)
      .deleteFrom("state_leases")
      .where("scope", "=", FLEET_OPERATION_LEASE_SCOPE)
      .where("lease_key", "=", params.tenantId)
      .where("owner", "=", params.owner),
  );
}

export function deleteFleetCellInDatabase(db: DatabaseSync, tenantId: string): void {
  executeSqliteQuerySync(
    db,
    kyselyFor(db).deleteFrom("fleet_cells").where("tenant_id", "=", tenantId),
  );
}
