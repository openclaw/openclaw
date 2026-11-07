import { createHash } from "node:crypto";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { CONTROL_UI_OPERATOR_SCOPES } from "../gateway/control-ui-bootstrap-contract.js";
import { resolveMissingRequestedScope } from "../shared/operator-scope-compat.js";
import { ensureDevicePairingBrowserRequestSchema } from "../state/openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { approveDevicePairingInWorker } from "./device-pairing-approval.kernel.js";
import { requestDevicePairingInWorker } from "./device-pairing-core.kernel.js";
import { requestDevicePairingMutationAdmission } from "./device-pairing-mutation.worker.js";
import { loadDevicePairingStateForMutation } from "./device-pairing-state.kernel.js";
import { persistDevicePairingStoreState } from "./device-pairing-store.js";
import { resolveRoleTokenScopes } from "./device-pairing-token-utils.js";
import type { PairedDevice } from "./device-pairing.types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { EngineConnection } from "./sql-connection.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "./sqlite-number.js";
import { deferSqlitePostCommitPublication } from "./sqlite-post-commit.js";

const OPERATOR_ROLE = "operator";

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
  approved_token_sha256: string | null;
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

/**
 * A revoked operator token, or one below the device's approved scopes, is a limit the
 * approval rules keep. Code pairing refuses rather than report access it cannot grant.
 */
function hasReducedOperatorToken(device: PairedDevice | undefined): boolean {
  const token = device?.tokens?.[OPERATOR_ROLE];
  if (!device || !token) {
    return false;
  }
  if (token.revokedAtMs !== undefined) {
    return true;
  }
  return (
    resolveMissingRequestedScope({
      role: OPERATOR_ROLE,
      requestedScopes: resolveRoleTokenScopes(
        OPERATOR_ROLE,
        device.approvedScopes ?? device.scopes,
      ),
      allowedScopes: token.scopes,
    }) !== null
  );
}

/** Identifies the exact token an approval handed over without keeping a second copy of it. */
function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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
      approved_token_sha256: null,
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

/** Withdraw only this key's request; an approval that already committed wins. */
export function cancelBrowserPairRequestInWorker(
  db: EngineConnection,
  input: { requestId: string; deviceId: string; publicKey: string },
) {
  const row = selectRequest(db, "request_id", input.requestId);
  // Verify ownership before exposing the outcome or changing even an expired row.
  if (!row || row.device_id !== input.deviceId || row.public_key !== input.publicKey) {
    return { status: "expired" as const };
  }
  if (row.status === "approved") {
    return { status: "approved" as const };
  }
  deleteRequest(db, input.requestId);
  // A missing row is deliberately opaque: its approval record may have expired.
  return { status: "cancelled" as const };
}

/**
 * Return a request's decision only to the key that filed it. An approved request keeps
 * answering until expiry so a dropped reply can be collected again; the token is read
 * from the paired device each time, which stays its only owner.
 */
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
  if (row.status === "rejected") {
    return { status: "rejected" as const };
  }
  if (row.status !== "approved") {
    return { status: "pending" as const };
  }
  const device = loadDevicePairingStateForMutation(input.nowMs).pairedByDeviceId[row.device_id];
  const token = device?.tokens?.[OPERATOR_ROLE];
  // Removed, re-keyed, revoked or rotated since approval: the owner's later decision
  // wins, so only the token this approval issued is ever handed over.
  if (
    !device ||
    device.publicKey !== row.public_key ||
    !token ||
    token.revokedAtMs ||
    tokenDigest(token.token) !== row.approved_token_sha256
  ) {
    return { status: "expired" as const };
  }
  return {
    status: "approved" as const,
    deviceToken: token.token,
    role: OPERATOR_ROLE,
    scopes: token.scopes,
    expiresAtMs: row.expires_at_ms,
  };
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
 * Settle the exact request the operator inspected. Approval files and approves an
 * ordinary operator pairing for the request's key under the caller's scopes, so
 * the result is the same paired device `openclaw devices approve` would produce,
 * never a bootstrap owner handoff. Rejection stays readable until expiry so the
 * waiting browser can show the outcome.
 */
export function decideBrowserPairRequestInWorker(
  db: EngineConnection,
  input: {
    code: string;
    requestId: string;
    decision: "approve" | "reject";
    callerScopes: readonly string[];
    /** Shared-auth generation browser tokens must carry, when shared auth is configured. */
    sharedGatewaySessionGeneration?: string;
    nowMs: number;
    collectExpiresAtMs: number;
  },
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
  // The caller rechecks the deadline with its live clock once this reaches the writer.
  requestDevicePairingMutationAdmission({
    kind: "browser-pair.decision",
    expiresAtMs: row.expires_at_ms,
  });
  const kysely = browserRequestDatabase(db);
  if (input.decision === "reject") {
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("device_pairing_browser_requests")
        .set({ status: "rejected" })
        .where("request_id", "=", row.request_id),
    );
    return { ...describeRequest(row, "rejected"), superseded: [] };
  }
  const state = loadDevicePairingStateForMutation(input.nowMs);
  if (hasReducedOperatorToken(state.pairedByDeviceId[row.device_id])) {
    return { status: "reduced" as const, deviceId: row.device_id };
  }
  // The browser's own earlier requests came from an unauthenticated handshake; the
  // operator approved this key for operator access, not whatever those asked for.
  const superseded = Object.values(state.pendingById)
    .filter((pending) => pending.deviceId === row.device_id)
    .map(({ requestId, deviceId }) => ({ requestId, deviceId }));
  if (superseded.length > 0) {
    for (const { requestId } of superseded) {
      delete state.pendingById[requestId];
    }
    persistDevicePairingStoreState(state, undefined, "pending");
  }
  const filed = requestDevicePairingInWorker(
    {
      deviceId: row.device_id,
      publicKey: row.public_key,
      clientId: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      clientMode: GATEWAY_CLIENT_MODES.WEBCHAT,
      ...(row.origin ? { browserOrigin: row.origin } : {}),
      ...(row.remote_ip ? { remoteIp: row.remote_ip } : {}),
      role: OPERATOR_ROLE,
      roles: [OPERATOR_ROLE],
      scopes: [...CONTROL_UI_OPERATOR_SCOPES],
    },
    input.nowMs,
  );
  const approved = approveDevicePairingInWorker(
    filed.request.requestId,
    {
      callerScopes: [...input.callerScopes],
      approvedVia: "owner",
      ...(input.sharedGatewaySessionGeneration
        ? {
            tokenIssuer: {
              kind: "shared-gateway-auth" as const,
              generation: input.sharedGatewaySessionGeneration,
            },
          }
        : {}),
    },
    input.nowMs,
  );
  if (approved?.status !== "approved") {
    // The method requires operator.admin, which covers every requested scope. Throwing
    // rolls back the filed request instead of leaving it in the operator approval list.
    throw new Error(
      `Browser pairing approval was refused: ${approved?.reason ?? "request missing"}`,
    );
  }
  const issued = approved.device.tokens?.[OPERATOR_ROLE];
  if (!issued) {
    throw new Error("Browser pairing approval issued no operator token");
  }
  executeSqliteQuerySync(
    db,
    kysely
      .updateTable("device_pairing_browser_requests")
      .set({
        status: "approved",
        approved_token_sha256: tokenDigest(issued.token),
        expires_at_ms: input.collectExpiresAtMs,
      })
      .where("request_id", "=", row.request_id),
  );
  return {
    ...describeRequest({ ...row, expires_at_ms: input.collectExpiresAtMs }, "approved"),
    superseded,
  };
}
