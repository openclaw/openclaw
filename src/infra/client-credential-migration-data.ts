import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { ClientCredentialDatabase } from "./client-credential-schema.js";
import { validateStoredDeviceIdentity } from "./device-identity-material.js";
import { stripExecApprovalsRawSocketCredentials } from "./exec-approvals-config.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { EngineConnection } from "./sql-connection.js";

export type ApprovalRow = {
  config_key: string;
  raw_json: string;
  socket_path: string | null;
  has_socket_token: number;
  default_security: string | null;
  default_ask: string | null;
  default_ask_fallback: string | null;
  auto_allow_skills: number | null;
  agent_count: number;
  allowlist_count: number;
  updated_at_ms: number;
};
export type LegacyDatabase = Pick<
  ClientCredentialDatabase,
  "device_identities" | "device_auth_tokens" | "gateway_origin_device_tokens"
> & {
  exec_approvals_config: ApprovalRow;
};

export function sourceRows(database: EngineConnection, nativeBootstrap: boolean) {
  const db = getNodeSqliteKysely<LegacyDatabase>(database);
  return sortClientCredentialRows({
    identities:
      nativeBootstrap && !tableExists(database, "device_identities")
        ? []
        : executeSqliteQuerySync(database, db.selectFrom("device_identities").selectAll()).rows,
    tokens:
      nativeBootstrap && !tableExists(database, "device_auth_tokens")
        ? []
        : executeSqliteQuerySync(database, db.selectFrom("device_auth_tokens").selectAll()).rows,
    origins:
      nativeBootstrap && !tableExists(database, "gateway_origin_device_tokens")
        ? []
        : executeSqliteQuerySync(
            database,
            db.selectFrom("gateway_origin_device_tokens").selectAll(),
          ).rows,
    approvals:
      nativeBootstrap && !tableExists(database, "exec_approvals_config")
        ? []
        : executeSqliteQuerySync(database, db.selectFrom("exec_approvals_config").selectAll()).rows,
  });
}

export function validateSource(
  rows: ReturnType<typeof sourceRows>,
  identityPolicy: "require-valid" | "preserve-for-doctor" = "require-valid",
): void {
  if (identityPolicy === "require-valid") {
    for (const row of rows.identities) {
      validateStoredDeviceIdentity(
        {
          deviceId: row.device_id,
          publicKeyPem: row.public_key_pem,
          privateKeyPem: row.private_key_pem,
          createdAtMs: row.created_at_ms,
        },
        row.identity_key,
      );
      if (!Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0) {
        throw new Error("Client credential migration found an invalid identity timestamp.");
      }
    }
  }
  for (const row of [...rows.tokens, ...rows.origins]) {
    let scopes: unknown;
    try {
      scopes = JSON.parse(row.scopes_json);
    } catch {
      throw new Error("Client credential migration found invalid token scopes.");
    }
    if (
      !Array.isArray(scopes) ||
      !scopes.every((scope) => typeof scope === "string") ||
      !Number.isSafeInteger(row.updated_at_ms) ||
      row.updated_at_ms < 0
    ) {
      throw new Error("Client credential migration found an invalid token record.");
    }
  }
  if (rows.approvals.some((row) => row.config_key !== "current") || rows.approvals.length > 1) {
    throw new Error("Client credential migration found a noncanonical approval singleton.");
  }
}

/** SQLite BINARY and PostgreSQL locale ordering must produce the same exact snapshot. */
function sortClientCredentialRows<
  T extends {
    identities: LegacyDatabase["device_identities"][];
    tokens: LegacyDatabase["device_auth_tokens"][];
    origins: LegacyDatabase["gateway_origin_device_tokens"][];
    approvals: ApprovalRow[];
  },
>(rows: T): T {
  const compare = (left: string, right: string) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right));
  rows.identities.sort((a, b) => compare(a.identity_key, b.identity_key));
  rows.tokens.sort((a, b) => compare(a.device_id, b.device_id) || compare(a.role, b.role));
  rows.origins.sort(
    (a, b) =>
      compare(a.gateway_scope, b.gateway_scope) ||
      compare(a.device_id, b.device_id) ||
      compare(a.role, b.role),
  );
  rows.approvals.sort((a, b) => compare(a.config_key, b.config_key));
  return rows;
}

export function hashClientCredentialRows(
  rows: ReturnType<typeof sourceRows>,
  native?: { authTablePresent: boolean },
): string {
  return createHash("sha256")
    .update(
      stableStringify(
        native
          ? {
              authTablePresent: native.authTablePresent,
              identities: rows.identities,
              tokens: rows.tokens,
            }
          : rows,
      ),
    )
    .digest("hex");
}

export function extractSocket(row: ApprovalRow | undefined) {
  if (!row) {
    return { socket: undefined, policy: undefined };
  }
  const invalid = () =>
    new Error("Client credential migration found invalid socket credentials or projections.");
  let policy: unknown;
  try {
    policy = JSON.parse(row.raw_json);
  } catch {
    throw new Error("Client credential migration found invalid approval JSON.");
  }
  const socket = isRecord(policy) ? policy.socket : undefined;
  if (socket !== undefined && !isRecord(socket)) {
    throw invalid();
  }
  const socketPath = isRecord(socket) ? socket.path : undefined;
  const socketToken = isRecord(socket) ? socket.token : undefined;
  if (
    (socketPath !== undefined && typeof socketPath !== "string") ||
    (socketToken !== undefined && typeof socketToken !== "string") ||
    (socketPath ?? null) !== row.socket_path ||
    (socketToken ? 1 : 0) !== row.has_socket_token
  ) {
    throw invalid();
  }
  if (socketPath === undefined && socketToken === undefined) {
    return { socket: undefined, policy: row.raw_json };
  }
  const value: ClientCredentialDatabase["native_exec_socket_credentials"] = {
    socket_key: "current",
    socket_path: socketPath ?? null,
    socket_token: socketToken ?? null,
    updated_at_ms: row.updated_at_ms,
  };
  return { socket: value, policy: stripExecApprovalsRawSocketCredentials(row.raw_json) };
}
