import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hasErrnoCode } from "../errno.js";
import { parseGatewayLockPayload } from "../gateway-lock-payload.js";
import {
  decodeGatewayOwnerLease,
  readGatewayOwnerLeaseFromDatabase,
} from "../gateway-owner-lease.read.js";
import type { GatewayOwnerLeaseIdentity } from "../gateway-owner-lease.types.js";
import { isGatewayStateOwnerDefinitelyStale } from "../gateway-state-owner-record.js";
import { captureGatewayStateOwner, resolveGatewayStateOwnerPath } from "../gateway-state-owner.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../sqlite-schema-facts.js";
import { quoteSqliteIdentifier as quote } from "../sqlite-schema-sql.js";
import { prepareSqliteReadOnlyLocation } from "../sqlite-snapshot-source.js";
import {
  createDatabaseStoreDiagnostic,
  type DatabaseStoreDiagnostic,
} from "./diagnostic-record.js";
import { readBackupEngineImage, type BackupEngine } from "./physical-store.js";
import type { PortDescriptor } from "./port-types.js";
import { readPostgresStoreMetadata, withPostgresConnection } from "./postgres-store-metadata.js";
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

function observeLease(
  result: DatabaseStoreDiagnostic,
  lease: GatewayOwnerLeaseIdentity | undefined,
) {
  result.lease =
    !lease || lease.state === "dead"
      ? "none"
      : lease.state === "live"
        ? "live-owner"
        : "unverifiable";
  if (result.lease === "unverifiable") {
    result.nextSteps.push("Inspect the recorded Gateway lease before offline maintenance.");
  }
}

function observeVersion(result: DatabaseStoreDiagnostic, version: number) {
  result.schema.versioning = "versioned";
  result.schema.version = version;
  const expected = result.schema.expectedVersion;
  if (expected === null) {
    return;
  }
  result.schema.pending = Math.max(0, expected - version);
  if (version < expected) {
    result.issues.push(`Schema migrations pending: version ${version}, expected ${expected}.`);
    result.nextSteps.push("Run openclaw doctor --fix with the matching OpenClaw version.");
  } else if (version > expected) {
    result.issues.push(`Schema version ${version} is newer than supported version ${expected}.`);
    result.nextSteps.push(
      "Use an OpenClaw version that supports this schema, or restore its matching backup.",
    );
  }
}

function inspectSqlite(
  result: DatabaseStoreDiagnostic,
  db: DatabaseSync,
  descriptor?: PortDescriptor,
) {
  admitSqliteSchema(db);
  const facts = getAdmittedSqliteSchemaFacts(db)!;
  result.connectivity = "local";
  result.extensions = [];
  if (descriptor?.inspectSqliteSource) {
    try {
      const source = descriptor.inspectSqliteSource(db);
      observeVersion(result, source.version);
      if (source.migrationRequired && source.version === result.schema.expectedVersion) {
        // Port preparation includes same-version repairs; it is not a schema-version gap.
        result.issues.push("Store preparation is required before porting.");
        result.nextSteps.push("Database porting performs this preparation on a private copy.");
      }
    } catch {
      // Core state and agent stores keep their authoritative version in user_version.
      if (result.family === "state" || result.family === "agent") {
        observeVersion(result, facts.userVersion);
      }
      result.issues.push("The SQLite schema could not be admitted by its store owner.");
      result.nextSteps.push("Run openclaw doctor --fix with the matching OpenClaw version.");
    }
  } else if (result.schema.versioning === "versioned") {
    observeVersion(result, facts.userVersion);
  }
  if (result.family === "state") {
    try {
      observeLease(result, readGatewayOwnerLeaseFromDatabase(db));
    } catch {
      result.issues.push("The recorded Gateway lease could not be verified.");
      result.nextSteps.push("Check the Gateway owner and rerun openclaw doctor.");
    }
  }
}

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

/** Operator-only, read-only inspection: one private SQLite snapshot and at most one PG connection. */
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
    const prepared = await prepareSqliteReadOnlyLocation(input.path, {
      preserveSourceArtifacts: true,
    });
    let engine: BackupEngine;
    try {
      engine = readBackupEngineImage(prepared.location, input.path);
      result.observed = engine.engine;
      result.mismatch = engine.engine !== input.configured.effective;
      if (result.mismatch) {
        result.issues.push(
          `Configured ${input.configured.effective}, but the physical store is ${engine.engine}.`,
        );
        result.nextSteps.push(
          input.configured.fixedLocal
            ? "Restore the fixed-local SQLite store from its verified backup."
            : `Stop the Gateway and run openclaw database port --family ${input.family} --to ${input.configured.effective}, or restore the matching engine configuration.`,
        );
      }
      if (engine.engine === "sqlite") {
        using db = openNodeSqliteDatabase(prepared.location, { readOnly: true });
        inspectSqlite(result, db, input.descriptor);
      }
    } finally {
      await prepared.cleanupAsync();
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
