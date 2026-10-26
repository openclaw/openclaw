import type { DatabaseSync } from "node:sqlite";
import type { ClientCredentialDatabase } from "./client-credential-schema.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

export type ClientNativeTokenSelector =
  | { kind: "all" }
  | { kind: "role"; role: string }
  | { kind: "gateway"; gateway: string }
  | { kind: "unscoped" };

function encodeClientNativeTokenRole(role: string, gateway: string): string {
  return `v2.${Buffer.from(gateway).toString("base64url")}.${Buffer.from(role.trim()).toString("base64url")}`;
}

function decodeRole(stored: string): { role: string; gateway: string | null } {
  const parts = stored.split(".");
  if (parts.length === 3 && parts[0] === "v2" && parts[1] !== undefined && parts[2] !== undefined) {
    try {
      const decode = (component: string) => {
        if (!/^[A-Za-z0-9_-]*$/u.test(component) || component.length % 4 === 1) {
          throw new Error("Invalid component");
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(component, "base64url"),
        );
      };
      return { gateway: decode(parts[1]), role: decode(parts[2]) };
    } catch {
      /* Older malformed keys remain unscoped, matching the native codec. */
    }
  }
  return { role: stored, gateway: null };
}

export function clearClientNativeTokens(
  database: DatabaseSync,
  deviceId: string,
  selector: ClientNativeTokenSelector,
): number {
  const db = getNodeSqliteKysely<ClientCredentialDatabase>(database);
  if (selector.kind === "all") {
    return Number(
      executeSqliteQuerySync(
        database,
        db.deleteFrom("device_auth_tokens").where("device_id", "=", deviceId),
      ).numAffectedRows,
    );
  }
  const rows = executeSqliteQuerySync(
    database,
    db.selectFrom("device_auth_tokens").select("role").where("device_id", "=", deviceId),
  );
  const roles = rows.rows
    .filter(({ role }) => {
      const decoded = decodeRole(role);
      if (selector.kind === "role") {
        return decoded.role === selector.role.trim();
      }
      if (selector.kind === "gateway") {
        return decoded.gateway === selector.gateway;
      }
      return decoded.gateway === null;
    })
    .map(({ role }) => role);
  if (roles.length === 0) {
    return 0;
  }
  executeSqliteQuerySync(
    database,
    db
      .deleteFrom("device_auth_tokens")
      .where("device_id", "=", deviceId)
      .where("role", "in", roles),
  );
  return roles.length;
}

/** A scoped winner is retained; the ambiguous legacy token is always consumed. */
export function claimClientNativeToken(
  database: DatabaseSync,
  deviceId: string,
  role: string,
  gateway: string,
): boolean {
  const db = getNodeSqliteKysely<ClientCredentialDatabase>(database);
  const legacyRole = role.trim();
  const source = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("device_auth_tokens")
      .selectAll()
      .where("device_id", "=", deviceId)
      .where("role", "=", legacyRole),
  );
  if (!source) {
    return false;
  }
  executeSqliteQuerySync(
    database,
    db
      .insertInto("device_auth_tokens")
      .values({ ...source, role: encodeClientNativeTokenRole(role, gateway) })
      .onConflict((conflict) => conflict.columns(["device_id", "role"]).doNothing()),
  );
  executeSqliteQuerySync(
    database,
    db
      .deleteFrom("device_auth_tokens")
      .where("device_id", "=", deviceId)
      .where("role", "=", legacyRole),
  );
  return true;
}
