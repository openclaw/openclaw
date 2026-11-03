import { ensureDevicePairingBrowserRequestSchema } from "../state/openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { issueBoundControlUiOwnerBootstrapToken } from "./device-bootstrap.worker-kernel.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { EngineConnection } from "./sql-connection.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "./sqlite-number.js";
import { deferSqlitePostCommitPublication } from "./sqlite-post-commit.js";

type BrowserRequestDatabase = Pick<OpenClawStateKyselyDatabase, "device_pairing_browser_requests">;
const initializedDatabases = new WeakSet<EngineConnection>();

function browserRequestDatabase(db: EngineConnection) {
  if (!initializedDatabases.has(db)) {
    ensureDevicePairingBrowserRequestSchema(db);
    // A refused commit also rolls back first-use DDL.
    deferSqlitePostCommitPublication(db, () => initializedDatabases.add(db));
  }
  return getNodeSqliteKysely<BrowserRequestDatabase>(db);
}

type BrowserRequestRow = {
  request_id: string;
  code: string;
  device_id: string;
  public_key: string;
  remote_ip: string | null;
  user_agent: string | null;
  origin: string | null;
  status: string;
  bootstrap_token: string | null;
  created_at_ms: number;
  expires_at_ms: number;
};

function selectRequest(
  db: EngineConnection,
  column: "code" | "request_id" | "device_id",
  value: string,
): BrowserRequestRow | undefined {
  const kysely = browserRequestDatabase(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    kysely.selectFrom("device_pairing_browser_requests").selectAll().where(column, "=", value),
  );
}

function deleteRequest(db: EngineConnection, requestId: string): void {
  const kysely = browserRequestDatabase(db);
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("device_pairing_browser_requests").where("request_id", "=", requestId),
  );
}

function describeRequest(row: BrowserRequestRow, status: "pending" | "approved" | "rejected") {
  return {
    status,
    requestId: row.request_id,
    code: row.code,
    deviceId: row.device_id,
    ...(row.remote_ip ? { remoteIp: row.remote_ip } : {}),
    ...(row.user_agent ? { userAgent: row.user_agent } : {}),
    ...(row.origin ? { origin: row.origin } : {}),
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
  };
}

/** File one browser's request, keeping its live code across repeated clicks. */
export function startBrowserPairRequestInWorker(
  db: EngineConnection,
  input: {
    requestId: string;
    codeCandidates: readonly string[];
    deviceId: string;
    publicKey: string;
    remoteIp?: string;
    userAgent?: string;
    origin?: string;
    nowMs: number;
    expiresAtMs: number;
    maxPending: number;
  },
) {
  const kysely = browserRequestDatabase(db);
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("device_pairing_browser_requests").where("expires_at_ms", "<=", input.nowMs),
  );
  const existing = selectRequest(db, "device_id", input.deviceId);
  if (existing?.status === "pending" && existing.public_key === input.publicKey) {
    return {
      status: "pending" as const,
      requestId: existing.request_id,
      code: existing.code,
      expiresAtMs: existing.expires_at_ms,
    };
  }
  if (existing) {
    deleteRequest(db, existing.request_id);
  }
  const pendingCount = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("device_pairing_browser_requests")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("status", "=", "pending"),
  );
  if (sqliteNumber(pendingCount?.count ?? 0) >= input.maxPending) {
    return { status: "capacity" as const };
  }
  const code = input.codeCandidates.find((candidate) => !selectRequest(db, "code", candidate));
  if (!code) {
    return { status: "capacity" as const };
  }
  executeSqliteQuerySync(
    db,
    kysely.insertInto("device_pairing_browser_requests").values({
      request_id: input.requestId,
      code,
      device_id: input.deviceId,
      public_key: input.publicKey,
      remote_ip: input.remoteIp ?? null,
      user_agent: input.userAgent ?? null,
      origin: input.origin ?? null,
      status: "pending",
      bootstrap_token: null,
      created_at_ms: input.nowMs,
      expires_at_ms: input.expiresAtMs,
    }),
  );
  return {
    status: "pending" as const,
    requestId: input.requestId,
    code,
    expiresAtMs: input.expiresAtMs,
  };
}

/** Return a request's decision only to the key that filed it. */
export function collectBrowserPairRequestInWorker(
  db: EngineConnection,
  input: { requestId: string; deviceId: string; publicKey: string; nowMs: number },
) {
  const row = selectRequest(db, "request_id", input.requestId);
  if (!row || row.device_id !== input.deviceId || row.public_key !== input.publicKey) {
    return { status: "unknown" as const };
  }
  if (row.expires_at_ms <= input.nowMs) {
    deleteRequest(db, row.request_id);
    return { status: "expired" as const };
  }
  if (row.status === "approved" && row.bootstrap_token) {
    return {
      status: "approved" as const,
      bootstrapToken: row.bootstrap_token,
      expiresAtMs: row.expires_at_ms,
    };
  }
  return { status: row.status === "rejected" ? ("rejected" as const) : ("pending" as const) };
}

/** Look up what a host operator is about to decide. */
export function inspectBrowserPairRequestInWorker(
  db: EngineConnection,
  input: { code: string; nowMs: number },
) {
  const row = selectRequest(db, "code", input.code);
  if (!row) {
    return { status: "unknown" as const };
  }
  if (row.expires_at_ms <= input.nowMs) {
    deleteRequest(db, row.request_id);
    return { status: "expired" as const };
  }
  if (row.status !== "pending") {
    return { status: "decided" as const };
  }
  return describeRequest(row, "pending");
}

/**
 * Settle the exact request the operator inspected. Approval issues the owner
 * handoff bound to the request's key, so the collected token cannot be redeemed
 * by anything but that browser; rejection stays readable until expiry so the
 * waiting browser can show the outcome.
 */
export function decideBrowserPairRequestInWorker(
  db: EngineConnection,
  input: { code: string; requestId: string; decision: "approve" | "reject"; nowMs: number },
) {
  const row = selectRequest(db, "code", input.code);
  if (!row || row.request_id !== input.requestId) {
    return { status: "unknown" as const };
  }
  if (row.expires_at_ms <= input.nowMs) {
    deleteRequest(db, row.request_id);
    return { status: "expired" as const };
  }
  if (row.status !== "pending") {
    return { status: "decided" as const };
  }
  const kysely = browserRequestDatabase(db);
  if (input.decision === "reject") {
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("device_pairing_browser_requests")
        .set({ status: "rejected" })
        .where("request_id", "=", row.request_id),
    );
    return describeRequest(row, "rejected");
  }
  const issued = issueBoundControlUiOwnerBootstrapToken({
    deviceId: row.device_id,
    publicKey: row.public_key,
    nowMs: input.nowMs,
  });
  executeSqliteQuerySync(
    db,
    kysely
      .updateTable("device_pairing_browser_requests")
      .set({ status: "approved", bootstrap_token: issued.token, expires_at_ms: issued.expiresAtMs })
      .where("request_id", "=", row.request_id),
  );
  return describeRequest({ ...row, expires_at_ms: issued.expiresAtMs }, "approved");
}
