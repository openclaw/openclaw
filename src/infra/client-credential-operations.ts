import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expressionBuilder } from "kysely";
import {
  clearClientNativeTokens,
  claimClientNativeToken,
  type ClientNativeTokenSelector,
} from "./client-credential-native-tokens.js";
import type { ClientCredentialDatabase } from "./client-credential-schema.js";
import {
  salvageStoredIdentityRow,
  storedDeviceIdentityFromRow,
  storedDeviceIdentityToRow,
} from "./device-identity-material.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

export type ClientIdentityRecord = ClientCredentialDatabase["device_identities"];
export type ClientTokenRecord = ClientCredentialDatabase["device_auth_tokens"];
export type ClientSocketRecord = ClientCredentialDatabase["native_exec_socket_credentials"];
export type ClientTokenKey = Pick<ClientTokenRecord, "device_id" | "role"> & {
  gateway_scope?: string;
};

/** Typed owner operations; IPC decoding belongs at its local transport boundary. */
export type ClientCredentialOperation =
  | { kind: "identity.read"; identity_key: string }
  | { kind: "identity.create"; identity: ClientIdentityRecord }
  | { kind: "identity.repair"; identity: ClientIdentityRecord }
  | {
      kind: "token.list";
      device_id: string;
      gateway_scope?: string;
      afterRole?: string;
      limit?: number;
    }
  | { kind: "native.tokens.clear"; device_id: string; selector: ClientNativeTokenSelector }
  | { kind: "native.token.claim"; device_id: string; role: string; gateway: string }
  | { kind: "token.read"; key: ClientTokenKey }
  | {
      kind: "token.replace";
      key: ClientTokenKey;
      token: ClientTokenRecord;
      expectedToken?: string | null;
    }
  | {
      kind: "token.remove";
      key: ClientTokenKey;
      expectedToken?: string | null;
      observedToken?: string;
    }
  | { kind: "socket.read" }
  | {
      kind: "socket.ensure";
      fallback: ClientSocketRecord;
      requested?: { path?: string; token?: string };
    };

export type ClientCredentialResult =
  | { kind: "identity"; identity: ClientIdentityRecord | null }
  | { kind: "token"; token: ClientTokenRecord | null }
  | { kind: "tokens"; tokens: ClientTokenRecord[]; nextRole: string | null }
  | { kind: "identityRepair"; identity: ClientIdentityRecord; repaired: boolean; rotated: boolean }
  | { kind: "changed"; changed: boolean }
  | { kind: "cleared"; count: number }
  | { kind: "socket"; socket: ClientSocketRecord | null };

export function performClientCredentialOperation(
  database: DatabaseSync,
  operation: ClientCredentialOperation,
  clientRoot: string,
): ClientCredentialResult {
  const db = getNodeSqliteKysely<ClientCredentialDatabase>(database);
  switch (operation.kind) {
    case "identity.read":
    case "identity.create":
    case "identity.repair": {
      const key =
        operation.kind === "identity.read"
          ? operation.identity_key
          : operation.identity.identity_key;
      const current = executeSqliteQueryTakeFirstSync(
        database,
        db.selectFrom("device_identities").selectAll().where("identity_key", "=", key),
      );
      if (operation.kind === "identity.repair") {
        if (current) {
          try {
            storedDeviceIdentityFromRow(current, key);
            return { kind: "identityRepair", identity: current, repaired: false, rotated: false };
          } catch {
            /* Only explicit Doctor repair may replace invalid material. */
          }
        }
        const salvaged = current
          ? salvageStoredIdentityRow(current, key, operation.identity.updated_at_ms)
          : null;
        const next = salvaged
          ? storedDeviceIdentityToRow(key, salvaged, operation.identity.updated_at_ms)
          : operation.identity;
        storedDeviceIdentityFromRow(next, key);
        executeSqliteQuerySync(
          database,
          db
            .insertInto("device_identities")
            .values(next)
            .onConflict((conflict) => conflict.column("identity_key").doUpdateSet(next)),
        );
        return {
          kind: "identityRepair",
          identity: next,
          repaired: true,
          rotated: salvaged === null,
        };
      }
      if (current) {
        storedDeviceIdentityFromRow(current, key);
        return { kind: "identity", identity: current };
      }
      if (operation.kind === "identity.create") {
        storedDeviceIdentityFromRow(operation.identity, key);
        executeSqliteQuerySync(
          database,
          db.insertInto("device_identities").values(operation.identity),
        );
        return { kind: "identity", identity: operation.identity };
      }
      return { kind: "identity", identity: null };
    }
    case "native.tokens.clear":
      return {
        kind: "cleared",
        count: clearClientNativeTokens(database, operation.device_id, operation.selector),
      };
    case "native.token.claim":
      return {
        kind: "changed",
        changed: claimClientNativeToken(
          database,
          operation.device_id,
          operation.role,
          operation.gateway,
        ),
      };
    case "token.list": {
      const table =
        operation.gateway_scope === undefined
          ? "device_auth_tokens"
          : "gateway_origin_device_tokens";
      let query = db.selectFrom(table).selectAll().where("device_id", "=", operation.device_id);
      if (operation.gateway_scope !== undefined) {
        query = query.where("gateway_scope", "=", operation.gateway_scope);
      }
      if (operation.afterRole !== undefined) {
        query = query.where("role", ">", operation.afterRole);
      }
      const limit = Math.max(1, Math.min(32, Math.trunc(operation.limit ?? 32)));
      const rows = executeSqliteQuerySync(database, query.orderBy("role").limit(limit + 1)).rows;
      const tokens = rows
        .slice(0, limit)
        .map(({ device_id, role, token, scopes_json, updated_at_ms }) => ({
          device_id,
          role,
          token,
          scopes_json,
          updated_at_ms,
        }));
      return {
        kind: "tokens",
        tokens,
        nextRole: rows.length > limit ? (tokens.at(-1)?.role ?? null) : null,
      };
    }
    case "token.read":
    case "token.replace":
    case "token.remove": {
      const { key } = operation;
      const table =
        key.gateway_scope === undefined ? "device_auth_tokens" : "gateway_origin_device_tokens";
      // Keep the two key spaces distinct; role strings already carry their native scope.
      const eb = expressionBuilder<
        ClientCredentialDatabase,
        "device_auth_tokens" | "gateway_origin_device_tokens"
      >();
      const matchKey = eb.and([
        eb("device_id", "=", key.device_id),
        eb("role", "=", key.role),
        ...(key.gateway_scope === undefined ? [] : [eb("gateway_scope", "=", key.gateway_scope)]),
      ]);
      const match = db.selectFrom(table).selectAll().where(matchKey);
      if (operation.kind === "token.read") {
        const row = executeSqliteQueryTakeFirstSync(database, match);
        return {
          kind: "token",
          token: row
            ? {
                device_id: row.device_id,
                role: row.role,
                token: row.token,
                scopes_json: row.scopes_json,
                updated_at_ms: row.updated_at_ms,
              }
            : null,
        };
      }
      const current = executeSqliteQueryTakeFirstSync(database, match);
      const matchesExpected =
        operation.expectedToken === undefined
          ? operation.kind !== "token.remove" || operation.observedToken === undefined
          : (current?.token ?? null) === operation.expectedToken;
      const matchesObserved =
        operation.kind === "token.remove" &&
        operation.observedToken !== undefined &&
        current?.token === operation.observedToken &&
        (operation.expectedToken === undefined ||
          (typeof operation.expectedToken === "string" &&
            operation.observedToken.trim() === operation.expectedToken));
      const matches = matchesExpected || matchesObserved;
      if (!matches) {
        return { kind: "changed", changed: false };
      }
      if (operation.kind === "token.remove") {
        if (!current) {
          return { kind: "changed", changed: false };
        }
        executeSqliteQuerySync(database, db.deleteFrom(table).where(matchKey));
      } else {
        const values = { ...operation.token, device_id: key.device_id, role: key.role };
        if (key.gateway_scope === undefined) {
          executeSqliteQuerySync(
            database,
            db
              .insertInto("device_auth_tokens")
              .values(values)
              .onConflict((conflict) =>
                conflict.columns(["device_id", "role"]).doUpdateSet(values),
              ),
          );
        } else {
          executeSqliteQuerySync(
            database,
            db
              .insertInto("gateway_origin_device_tokens")
              .values({ ...values, gateway_scope: key.gateway_scope })
              .onConflict((conflict) =>
                conflict.columns(["gateway_scope", "device_id", "role"]).doUpdateSet(values),
              ),
          );
        }
      }
      return { kind: "changed", changed: true };
    }
    case "socket.read":
    case "socket.ensure": {
      const current =
        executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("native_exec_socket_credentials")
            .selectAll()
            .where("socket_key", "=", "current"),
        ) ?? null;
      if (operation.kind === "socket.read") {
        return { kind: "socket", socket: current };
      }
      const requestedPath = operation.requested?.path?.trim();
      const previousPath = current?.socket_path;
      const useFallbackPath =
        !requestedPath &&
        previousPath === path.join(clientRoot, "exec-approvals.sock") &&
        previousPath !== operation.fallback.socket_path;
      const socket: ClientSocketRecord = {
        socket_key: "current",
        socket_path:
          requestedPath ||
          (useFallbackPath ? operation.fallback.socket_path : previousPath) ||
          operation.fallback.socket_path,
        socket_token:
          operation.requested?.token?.trim() ||
          current?.socket_token ||
          operation.fallback.socket_token,
        updated_at_ms: operation.fallback.updated_at_ms,
      };
      if (
        current &&
        current.socket_path === socket.socket_path &&
        current.socket_token === socket.socket_token
      ) {
        return { kind: "socket", socket: current };
      }
      executeSqliteQuerySync(
        database,
        db
          .insertInto("native_exec_socket_credentials")
          .values(socket)
          .onConflict((conflict) => conflict.column("socket_key").doUpdateSet(socket)),
      );
      return { kind: "socket", socket };
    }
    default:
      throw new Error("Unsupported client credential operation.");
  }
}
