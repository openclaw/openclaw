import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { CLAW_SCHEMA_VERSION } from "./manifest-contract.js";
import {
  rowToPackageRef,
  type PackageRefRow,
  type PersistedClawPackageRef,
  type ClawPackageRefStatus,
} from "./package-extension-provenance.js";
import { decodeClawAgentOwnership } from "./provenance-agent-origin.js";
import { clawBootstrapProvenanceFromRow } from "./provenance-bootstrap.js";
import * as installRecordSchema from "./provenance-schema-version.js";
import type { ClawOrphanWorkspace, PersistedClawInstall } from "./provenance-types.js";

type ClawInstallRow = Omit<
  DB["claw_installs"],
  "source_byte_length" | "manifest_schema_version" | "added_at_ms" | "updated_at_ms"
> & {
  source_byte_length: number | bigint;
  manifest_schema_version: number | bigint;
  added_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

function clawInstallRecordFromRow(row: ClawInstallRow): PersistedClawInstall {
  if (
    (row.source_kind !== "package" && row.source_kind !== "development") ||
    (row.integrity_kind !== "artifact" && row.integrity_kind !== "development-snapshot") ||
    (row.status !== "pending" &&
      row.status !== "workspace_ready" &&
      row.status !== "config_committed" &&
      row.status !== "complete" &&
      row.status !== "partial")
  ) {
    throw new Error("Claw install record has invalid source or status fields.");
  }
  const ownership = decodeClawAgentOwnership(row.agent_owned_paths_json, row.schema_version);
  const manifestSchemaVersion = sqliteNumber(row.manifest_schema_version);
  if (manifestSchemaVersion !== CLAW_SCHEMA_VERSION) {
    throw new Error(`Unsupported Claw manifest schema ${manifestSchemaVersion}.`);
  }
  return {
    schemaVersion: installRecordSchema.parseClawInstallRecordSchemaVersion(row.schema_version),
    claw: {
      kind: row.source_kind,
      name: row.claw_name,
      version: row.claw_version,
      packageRoot: row.package_root,
      manifestPath: row.manifest_path,
      integrityKind: row.integrity_kind,
      integrity: row.integrity,
      byteLength: sqliteNumber(row.source_byte_length),
    },
    manifestSchemaVersion,
    planIntegrity: row.plan_integrity,
    agentId: row.agent_id,
    workspace: row.workspace,
    agentConfigDigest: row.agent_config_digest,
    agentOrigin: ownership.origin,
    agentOwnedPaths: ownership.paths,
    ...clawBootstrapProvenanceFromRow(row),
    status: row.status,
    addedAtMs: sqliteNumber(row.added_at_ms),
    updatedAtMs: sqliteNumber(row.updated_at_ms),
  };
}

function selectClawInstallRow(db: DatabaseSync, agentId: string): ClawInstallRow | undefined {
  return (
    db /* sqlite-allow-raw: this Claw prototype state-table read is scoped to one owned row. */
      .prepare(
        `SELECT agent_id, schema_version, source_kind, claw_name, claw_version,
              package_root, manifest_path, integrity_kind, integrity, source_byte_length,
              manifest_schema_version, plan_integrity, workspace, agent_config_digest,
              agent_owned_paths_json, bootstrap_source_path, bootstrap_content_digest,
              status, added_at_ms, updated_at_ms
         FROM claw_installs
        WHERE agent_id = ?`,
      )
      // SAFETY: The explicit projection reads the admitted Claw install table and its writer-owned discriminants.
      .get(agentId) as ClawInstallRow | undefined
  );
}

export function readClawInstallRecordFromDatabase(
  db: DatabaseSync,
  agentId: string,
): PersistedClawInstall | undefined {
  const row = selectClawInstallRow(db, agentId);
  return row ? clawInstallRecordFromRow(row) : undefined;
}

export function readClawInstallRecordsInDatabase(db: DatabaseSync): PersistedClawInstall[] {
  const rows =
    db /* sqlite-allow-raw: read-only Claw install inventory ordered by stable agent id. */
      .prepare(
        `SELECT schema_version, source_kind, claw_name, claw_version, package_root,
              manifest_path, integrity_kind, integrity, source_byte_length,
              manifest_schema_version, plan_integrity, agent_id, workspace,
              agent_config_digest, agent_owned_paths_json, bootstrap_source_path, bootstrap_content_digest,
              status, added_at_ms,
              updated_at_ms
         FROM claw_installs
        ORDER BY agent_id`,
      )
      // SAFETY: This inventory uses the same admitted install projection as the exact-row reader.
      .all() as ClawInstallRow[];
  return rows.map(clawInstallRecordFromRow);
}

export type ClawPackageRefQuery = {
  agentId?: string;
  kind?: PersistedClawPackageRef["kind"];
  source?: PersistedClawPackageRef["source"];
  ref?: string;
  version?: string;
  integrity?: string;
  status?: ClawPackageRefStatus;
};

export function readClawPackageRefsInDatabase(
  db: DatabaseSync,
  options: ClawPackageRefQuery = {},
): PersistedClawPackageRef[] {
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  for (const [column, value] of [
    ["agent_id", options.agentId],
    ["package_kind", options.kind],
    ["package_source", options.source],
    ["package_ref", options.ref],
    ["package_version", options.version],
    ["package_integrity", options.integrity],
    ["package_status", options.status],
  ] as const) {
    if (value !== undefined) {
      conditions.push(`${column} = @${column}`);
      params[column] = value;
    }
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const rows =
    db /* sqlite-allow-raw: read-only Claw package reference lookup with closed column filters. */
      .prepare(
        `SELECT schema_version, agent_id, claw_name, package_kind, package_source,
              package_ref, package_version, package_integrity, package_status, relationship, origin,
              independent_owner, extension_id, extension_format, extension_detected_format,
              extension_mapped_json, extension_unavailable_json, extension_adapter_identity,
              installed_at_ms,
              updated_at_ms
         FROM claw_package_refs${where}
        ORDER BY agent_id, package_kind, package_ref`,
      )
      // SAFETY: The explicit projection matches the admitted package-reference schema consumed by its row codec.
      .all(params) as PackageRefRow[];
  return rows.map(rowToPackageRef);
}

export function readClawOrphanWorkspaceInDatabase(
  db: DatabaseSync,
  agentId: string,
): ClawOrphanWorkspace | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<Pick<DB, "claw_workspace_files">>(db)
      .selectFrom("claw_workspace_files")
      .select(["workspace", "updated_at_ms"])
      .where("agent_id", "=", agentId)
      .orderBy("target_path")
      .limit(1),
  );
  return row
    ? { workspace: row.workspace, updatedAtMs: sqliteNumber(row.updated_at_ms) }
    : undefined;
}
