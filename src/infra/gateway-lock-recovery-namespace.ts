import fs from "node:fs";
import { sql } from "kysely";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  classifyGatewayOwnerProcessNamespace,
  GATEWAY_OWNER_HEARTBEAT_STALE_MS,
  isLegacyGatewayLeaseLock,
  LEGACY_GATEWAY_OWNER_LEASE_TTL_MS,
  readLockHeartbeat,
} from "./gateway-lock-payload.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveReadOnlyShmSqliteFileUri } from "./node-sqlite.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";

/**
 * File-lock recovery also covers pre-namespace (before 2026.10.1) records from supported
 * upgrades on hosts whose PIDs are kernel-global. Linux legacy Gateways use their DB lease.
 */
export function classifyGatewayLockProcessNamespace(
  holder:
    | {
        processNamespace?: unknown;
        machineIdentity?: unknown;
        pid?: unknown;
        startTime?: unknown;
        ownerId?: unknown;
        role?: unknown;
        createdAt?: unknown;
      }
    | null
    | undefined,
  lockPath?: string,
  databasePath?: string,
): "same" | "dead" | "unknown" {
  if (holder && databasePath && isLegacyGatewayLeaseLock(holder)) {
    const now = Date.now();
    const createdAt = Date.parse(holder.createdAt);
    if (!Number.isFinite(createdAt) || now - createdAt <= LEGACY_GATEWAY_OWNER_LEASE_TTL_MS) {
      return "unknown";
    }
    try {
      // This lock primitive must inspect the selected DB before it can obtain maintenance.
      // Read the live WAL without changing its SHM; legacy files never renew their mtime.
      const db = openNodeSqliteDatabase(resolveReadOnlyShmSqliteFileUri(databasePath), {
        readOnly: true,
      });
      try {
        const stateDb = getNodeSqliteKysely<Pick<DB, "state_leases">>(db);
        const { rows } = executeSqliteQuerySync(db, {
          compile: () =>
            /* kysely-allow-raw: lock recovery must not trust a damaged lease lookup index. */
            sql<{ expiresAt: number | null }>`SELECT expires_at AS expiresAt
              FROM ${sql`state_leases NOT INDEXED`}
              WHERE scope = ${"gateway-owner"} AND owner = ${holder.ownerId}`.compile(stateDb),
        });
        return rows.every((row) => typeof row.expiresAt === "number" && row.expiresAt <= now)
          ? "dead"
          : "unknown";
      } finally {
        db.close();
      }
    } catch {
      // Missing/unreadable databases, old schemas and PostgreSQL anchors prove nothing.
      return "unknown";
    }
  }
  if (
    (process.platform === "win32" || process.platform === "darwin") &&
    holder &&
    holder.processNamespace === undefined &&
    lockPath
  ) {
    try {
      // A missing namespace never grants local authority. Only an expired heartbeat
      // plus native proof of process death can retire this legacy file owner.
      if (
        Date.now() - fs.statSync(lockPath).mtimeMs > GATEWAY_OWNER_HEARTBEAT_STALE_MS &&
        isLockOwnerDefinitelyStale({ payload: { pid: holder.pid, starttime: holder.startTime } })
      ) {
        return "dead";
      }
    } catch {
      // Unavailable heartbeat or process observations preserve the owner.
    }
    return "unknown";
  }
  return classifyGatewayOwnerProcessNamespace(holder?.processNamespace, {
    machineIdentity: holder?.machineIdentity,
    readGatewayHeartbeat: lockPath ? () => readLockHeartbeat(lockPath) : undefined,
  });
}
