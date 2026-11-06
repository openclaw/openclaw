import fs from "node:fs";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hasErrnoCode } from "../errno.js";
import { parseGatewayLockPayload } from "../gateway-lock-payload.js";
import { decodeGatewayOwnerLease } from "../gateway-owner-lease.read.js";
import { isGatewayStateOwnerDefinitelyStale } from "../gateway-state-owner-record.js";
import { captureGatewayStateOwner, resolveGatewayStateOwnerPath } from "../gateway-state-owner.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { hasVerifiedLiveSqliteOwner } from "../sqlite-live-owner.js";
import {
  runSqliteReadOnlyOperation,
  withSqliteReadOnlyWorkerScope,
} from "../sqlite-readonly-worker.js";
import { quoteSqliteIdentifier as quote } from "../sqlite-schema-sql.js";
import { prepareSqliteReadOnlyLocation } from "../sqlite-snapshot-source.js";
import { readDatabasePathIdentity } from "../sqlite-worker-identity.js";
import {
  createDatabaseStoreDiagnostic,
  type DatabaseStoreDiagnostic,
} from "./diagnostic-record.js";
import type { BackupEngine } from "./physical-store.js";
import type { PortDescriptor } from "./port-types.js";
import { readPostgresStoreMetadata, withPostgresConnection } from "./postgres-store-metadata.js";
import {
  inspectSqliteStoreImage,
  observeLease,
  observeVersion,
} from "./sqlite-store-inspection.js";
import type { DatabaseEngineInput } from "./types.js";

export type { DatabaseStoreDiagnostic } from "./diagnostic-record.js";

export type DatabaseStoreInspection = Pick<
  DatabaseStoreDiagnostic,
  "family" | "path" | "configured"
> & {
  descriptor?: PortDescriptor;
  schemaVersion?: number | null;
  postgres?: DatabaseEngineInput;
  inspectionError?: "unreadable-root";
};

function inspectSearchMetadata(result: DatabaseStoreDiagnostic, value: unknown) {
  const metadata = asOptionalRecord(value);
  if (!metadata) {
    throw new Error("Invalid PostgreSQL metadata");
  }
  const raw: unknown =
    typeof metadata.search_extensions === "string"
      ? JSON.parse(metadata.search_extensions)
      : (metadata.search_extensions ?? {});
  const extensions = asOptionalRecord(raw);
  if (!extensions) {
    throw new Error("Invalid PostgreSQL search-extension metadata");
  }
  const admitted: string[] = [];
  const degraded: string[] = [];
  for (const [name, definition] of Object.entries(extensions)) {
    const search = asOptionalRecord(definition);
    if (!search) {
      throw new Error("Invalid PostgreSQL search-extension definition");
    }
    admitted.push(name);
    if (search.mode === "keyword-only") {
      degraded.push(`${name}: keyword-only`);
    }
  }
  result.admittedExtensions = admitted;
  // Recorded extensions do not prove the base search capability is admitted.
  result.degraded = degraded.length ? degraded : null;
}

async function inspectPostgres(
  result: DatabaseStoreDiagnostic,
  engine: Extract<BackupEngine, { engine: "postgres" }>,
  input: DatabaseEngineInput,
) {
  result.namespace = engine.namespace;
  result.storeId = engine.storeId;
  if (!input) {
    result.issues.push(
      "PostgreSQL connection is not resolved; connectivity and schema are unknown.",
    );
    result.nextSteps.push(
      "Configure database.postgres.connection or repair its SecretRef, then rerun openclaw doctor.",
    );
    return;
  }
  try {
    await withPostgresConnection(
      input,
      async (client) => {
        result.connectivity = "reachable";
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        try {
          await client.query("SET LOCAL statement_timeout = '3000ms'");
          const identity = await client.query<{ database: string; extensions: string[] }>(
            "SELECT current_database() AS database, ARRAY(SELECT extname::text FROM pg_extension ORDER BY extname) AS extensions",
          );
          const server = identity.rows[0];
          if (!server) {
            throw new Error("PostgreSQL identity is unavailable");
          }
          result.database = server.database;
          result.extensions = server.extensions;
          const metadata = await readPostgresStoreMetadata(client, engine);
          if (metadata.store !== result.family) {
            result.issues.push("PostgreSQL metadata belongs to a different store family.");
            result.nextSteps.push(
              "Restore the matching PostgreSQL schema and anchor before starting the Gateway.",
            );
            return;
          }
          observeVersion(result, metadata.version);
          const stored = await client.query<{ metadata: unknown }>(
            `SELECT to_jsonb(meta) AS metadata FROM ${quote(engine.namespace)}.openclaw_schema_meta AS meta`,
          );
          inspectSearchMetadata(result, stored.rows[0]?.metadata);
          if (result.family === "agent" && !result.extensions.includes("vector")) {
            result.degraded = [
              ...(result.degraded ?? []),
              "vector search unavailable: pgvector is not installed",
            ];
            result.nextSteps.push(
              "Ask the database administrator to run CREATE EXTENSION vector; grant USAGE on its schema to the OpenClaw role.",
            );
          }
          if (result.family === "state") {
            const rows = await client.query<{
              owner: string;
              createdAt: string;
              expiresAt: string | null;
              heartbeatAt: string | null;
              payloadJson: string | null;
            }>(
              `SELECT owner, created_at AS "createdAt", expires_at AS "expiresAt", heartbeat_at AS "heartbeatAt", payload_json AS "payloadJson" FROM ${quote(engine.namespace)}.state_leases WHERE scope = $1 AND lease_key = $2 LIMIT 2`,
              ["gateway-owner", "global"],
            );
            if (rows.rows.length > 1) {
              throw new Error("Ambiguous Gateway lease");
            }
            const row = rows.rows[0];
            observeLease(
              result,
              decodeGatewayOwnerLease(
                row
                  ? {
                      owner: row.owner,
                      createdAt: Number(row.createdAt),
                      expiresAt: row.expiresAt === null ? null : Number(row.expiresAt),
                      heartbeatAt: row.heartbeatAt === null ? null : Number(row.heartbeatAt),
                      payloadJson: row.payloadJson,
                    }
                  : undefined,
              ),
            );
          }
        } finally {
          await client.query("ROLLBACK");
        }
      },
      { connectionTimeoutMillis: 3_000, query_timeout: 3_000 },
    );
  } catch {
    if (result.connectivity === "reachable") {
      result.issues.push("PostgreSQL store metadata or owner lease could not be verified.");
      result.nextSteps.push(
        "Check the configured role's schema access and run openclaw doctor --fix with the matching version; restore the matching schema and anchor if verification fails.",
      );
    } else {
      result.connectivity = "unreachable";
      result.issues.push(
        "PostgreSQL is unreachable; schema, extensions, and ownership are unknown.",
      );
      result.nextSteps.push(
        "Check PostgreSQL service/port, network access, and database.postgres.connection or its SecretRef, then rerun openclaw doctor.",
      );
    }
  }
}

/**
 * A verified live WAL source is read in place by an isolated child: closing the
 * source there cannot release another owner's POSIX locks, and a WAL reader
 * never blocks the writer. Every other source, or any failure, keeps the copy.
 */
async function readLiveWalSource(input: DatabaseStoreInspection, result: DatabaseStoreDiagnostic) {
  try {
    // Shared state inspects without its descriptor; descriptor checks stay on the private copy.
    const descriptorFree = input.family === "state" || !input.descriptor?.inspectSqliteSource;
    if (!input.path || !descriptorFree || !hasVerifiedLiveSqliteOwner(input.path)) {
      return undefined;
    }
    const { key } = await readDatabasePathIdentity(input.path);
    return await withSqliteReadOnlyWorkerScope(() =>
      runSqliteReadOnlyOperation(
        input.path!,
        { type: "databaseStore.inspectLive", input: { diagnostic: result } },
        { source: "canonical", expectedIdentity: key, env: process.env },
      ),
    );
  } catch {
    return undefined;
  }
}

/** Operator-only, read-only inspection: a live WAL read in place, else one private SQLite snapshot, and at most one PG connection. */
export async function inspectDatabaseStore(
  input: DatabaseStoreInspection,
): Promise<DatabaseStoreDiagnostic> {
  const result = createDatabaseStoreDiagnostic({
    family: input.family,
    path: input.path,
    configured: input.configured,
  });
  result.schema.versioning =
    input.schemaVersion === null
      ? "unversioned"
      : input.descriptor || input.schemaVersion !== undefined
        ? "versioned"
        : "unknown";
  result.schema.expectedVersion =
    input.schemaVersion === null
      ? null
      : (input.schemaVersion ?? input.descriptor?.version ?? null);
  result.legacyMigrations.state = input.configured.fixedLocal ? "none" : "unknown";
  if (input.inspectionError === "unreadable-root") {
    result.issues.push("The physical store root could not be read; its contents are unknown.");
    result.nextSteps.push("Check store path permissions, then rerun openclaw doctor.");
    return result;
  }
  let absent = !input.path;
  if (input.path) {
    try {
      fs.statSync(input.path);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
        absent = true;
      } else {
        result.issues.push("The physical store path could not be inspected.");
        result.nextSteps.push("Check store path permissions, then rerun openclaw doctor.");
        return result;
      }
    }
  }
  if (absent || !input.path) {
    result.nextSteps.push(
      "Store is not present. Initialize it through its owning feature, then rerun openclaw doctor.",
    );
    return result;
  }
  try {
    try {
      const ownerPath = resolveGatewayStateOwnerPath(input.path);
      let recorded;
      try {
        recorded = parseGatewayLockPayload(fs.readFileSync(ownerPath, "utf8"));
        if (!recorded) {
          throw new Error("Invalid owner record");
        }
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
      }
      result.custody = captureGatewayStateOwner(input.path)
        ? "live-owner"
        : input.family === "state" &&
            (!recorded || isGatewayStateOwnerDefinitelyStale(recorded, ownerPath))
          ? "none"
          : "unverifiable";
      if (recorded && result.custody === "unverifiable") {
        result.nextSteps.push(
          "Inspect the recorded store owner's custody before offline maintenance.",
        );
      }
    } catch {
      result.issues.push("Physical store custody could not be verified.");
      result.nextSteps.push("Check the Gateway owner and rerun openclaw doctor.");
    }
    let engine: BackupEngine;
    const live = await readLiveWalSource(input, result);
    if (live) {
      Object.assign(result, live.diagnostic);
      engine = live.engine;
    } else {
      const prepared = await prepareSqliteReadOnlyLocation(input.path, {
        preserveSourceArtifacts: true,
      });
      try {
        using db = openNodeSqliteDatabase(prepared.location, { readOnly: true });
        engine = inspectSqliteStoreImage(result, db, input.path, input.descriptor);
      } finally {
        await prepared.cleanupAsync();
      }
    }
    if (engine.engine === "postgres") {
      await inspectPostgres(result, engine, input.postgres);
    }
  } catch {
    result.issues.push("The physical store could not be inspected safely.");
    result.nextSteps.push(
      "Run openclaw doctor --fix with the matching version, or restore this store's verified backup.",
    );
  }
  if (result.observed === "postgres" && result.degraded === null) {
    result.nextSteps.push(
      "Search readiness was not verified; reopen the store through its owning feature to verify base search capabilities.",
    );
  }
  if (result.schema.expectedVersion === null && result.schema.versioning !== "unversioned") {
    result.nextSteps.push(
      "The store owner did not provide an expected schema version; use the matching plugin or OpenClaw version for schema verification.",
    );
  }
  result.nextSteps = [...new Set(result.nextSteps)];
  return result;
}
