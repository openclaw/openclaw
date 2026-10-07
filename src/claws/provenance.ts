// Persists the root ownership record for one Claw-created agent and workspace.

import { stableStringify } from "@openclaw/normalization-core";
import {
  assertAgentDeletionAllowsMutation,
  type AgentDeletionOperation,
} from "../agents/agent-lifecycle-registry.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { digestClawValue } from "./digest.js";
import {
  CLAW_PACKAGE_REF_SCHEMA_VERSION,
  rowToPackageRef,
  toPackageRefExtensionSqlParams,
  type ClawPackageOrigin,
  type ClawPackageRefStatus,
  type ClawPackageRelationship,
  type PackageRefRow,
  type PersistedClawPackageRef,
} from "./package-extension-provenance.js";
import { updateClawPackageRefStatusInDatabase } from "./package-status.kernel.js";
import { encodeClawAgentOwnership, type ClawAgentOrigin } from "./provenance-agent-origin.js";
import {
  readClawInstallRecordFromDatabase,
  readClawInstallRecordsInDatabase,
  readClawPackageRefsInDatabase,
  type ClawPackageRefQuery,
} from "./provenance-read.kernel.js";
import {
  cacheClawInstallSchemaVersion,
  deleteCachedClawInstallSchemaVersion,
} from "./provenance-runtime-read.js";
import * as installRecordSchema from "./provenance-schema-version.js";
import type {
  ClawInstallRecordUpdate,
  ClawInstallStatus,
  PersistedClawInstall,
} from "./provenance-types.js";
import type { ClawAddPlan, ResolvedClawPackage } from "./types.js";
export {
  persistClawMigrationOwnership,
  releaseAdoptedClawInstallRecord,
} from "./provenance-adopted.js";
export {
  CLAW_PACKAGE_REF_SCHEMA_VERSION,
  type PersistedClawPackageRef,
} from "./package-extension-provenance.js";
export type { ClawInstallStatus, PersistedClawInstall } from "./provenance-types.js";

type ClawProvenanceDatabase = Pick<
  DB,
  "claw_installs" | "claw_package_refs" | "claw_workspace_files"
>;

function agentOwnedPaths(plan: Pick<ClawInstallRecordUpdate, "actions">): string[] {
  return plan.actions.filter((action) => action.kind === "agent").map((action) => action.target);
}

function bootstrapProvenance(plan: Pick<ClawInstallRecordUpdate, "actions">) {
  const action = plan.actions.find((candidate) => candidate.kind === "bootstrap");
  const sourcePath = action?.details?.sourcePath;
  return action && typeof sourcePath === "string" && action.digest
    ? { sourcePath, contentDigest: action.digest }
    : undefined;
}

export function clawInstallRecordMatchesPlan(
  record: PersistedClawInstall,
  plan: ClawAddPlan,
): boolean {
  const bootstrap = bootstrapProvenance(plan);
  return (
    record.claw.kind === plan.claw.kind &&
    record.claw.name === plan.claw.name &&
    record.claw.version === plan.claw.version &&
    record.claw.packageRoot === plan.claw.packageRoot &&
    record.claw.manifestPath === plan.claw.manifestPath &&
    record.claw.integrityKind === plan.claw.integrityKind &&
    record.claw.integrity === plan.claw.integrity &&
    record.claw.byteLength === plan.claw.byteLength &&
    record.manifestSchemaVersion === plan.manifestSchemaVersion &&
    record.planIntegrity === plan.planIntegrity &&
    record.workspace === plan.agent.workspace &&
    record.agentConfigDigest === digestClawValue(plan.agent.config) &&
    stableStringify(record.agentOwnedPaths) === stableStringify(agentOwnedPaths(plan)) &&
    record.bootstrap?.sourcePath === bootstrap?.sourcePath &&
    record.bootstrap?.contentDigest === bootstrap?.contentDigest
  );
}

export function readClawInstallRecord(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawInstall | undefined {
  return readClawInstallRecordFromDatabase(openOpenClawStateDatabase(options).db, agentId);
}

export function persistClawInstallRecord(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    status?: ClawInstallStatus;
    nowMs?: number;
    expectedExistingRecord?: PersistedClawInstall;
    expectedExistingPlan?: ClawAddPlan;
    deferLegacyPlanUpgrade?: boolean;
    agentOrigin?: ClawAgentOrigin;
  } = {},
): PersistedClawInstall {
  const nowMs = options.nowMs ?? Date.now();
  const status = options.status ?? "complete";
  const agentConfigDigest = digestClawValue(plan.agent.config);
  const ownedPaths = agentOwnedPaths(plan);
  const ownership = encodeClawAgentOwnership(ownedPaths, options.agentOrigin ?? "created");
  const bootstrap = bootstrapProvenance(plan);
  const persistedRecord = runOpenClawStateWriteTransaction((database) => {
    assertAgentDeletionAllowsMutation(database, plan.agent.finalId);
    const { db } = database;
    const record = readClawInstallRecordFromDatabase(db, plan.agent.finalId);
    if (record) {
      const expectedPlan = options.expectedExistingPlan ?? plan;
      if (record.status !== "complete" && clawInstallRecordMatchesPlan(record, expectedPlan)) {
        if (record.schemaVersion !== installRecordSchema.CLAW_INSTALL_RECORD_SCHEMA_VERSION) {
          if (options.deferLegacyPlanUpgrade) {
            return record;
          }
          return upgradeClawInstallSchema(
            database,
            plan.agent.finalId,
            record,
            options.expectedExistingRecord,
            {
              planIntegrity: plan.planIntegrity,
              agentConfigDigest,
            },
          );
        }
        return record;
      }
      // A nonmatching partial attempt remains durable ownership evidence. A later
      // remove/doctor lifecycle must clear it; a new plan must never overwrite it.
      throw new Error(
        `Claw install record for agent ${JSON.stringify(plan.agent.finalId)} already exists.`,
      );
    }
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<ClawProvenanceDatabase>(db)
        .insertInto("claw_installs")
        .values({
          agent_id: plan.agent.finalId,
          schema_version: ownership.schemaVersion,
          source_kind: plan.claw.kind,
          claw_name: plan.claw.name,
          claw_version: plan.claw.version,
          package_root: plan.claw.packageRoot,
          manifest_path: plan.claw.manifestPath,
          integrity_kind: plan.claw.integrityKind,
          integrity: plan.claw.integrity,
          source_byte_length: plan.claw.byteLength,
          manifest_schema_version: plan.manifestSchemaVersion,
          plan_integrity: plan.planIntegrity,
          workspace: plan.agent.workspace,
          agent_config_digest: agentConfigDigest,
          agent_owned_paths_json: ownership.agentOwnedPathsJson,
          bootstrap_source_path: bootstrap?.sourcePath ?? null,
          bootstrap_content_digest: bootstrap?.contentDigest ?? null,
          status,
          added_at_ms: nowMs,
          updated_at_ms: nowMs,
        }),
    );
    return {
      schemaVersion: ownership.schemaVersion,
      claw: plan.claw,
      manifestSchemaVersion: plan.manifestSchemaVersion,
      planIntegrity: plan.planIntegrity,
      agentId: plan.agent.finalId,
      workspace: plan.agent.workspace,
      agentConfigDigest,
      agentOrigin: options.agentOrigin ?? "created",
      agentOwnedPaths: ownedPaths,
      ...(bootstrap ? { bootstrap } : {}),
      status,
      addedAtMs: nowMs,
      updatedAtMs: nowMs,
    };
  }, options);
  cacheClawInstallSchemaVersion(
    plan.agent.finalId,
    persistedRecord.schemaVersion,
    persistedRecord.agentConfigDigest,
    options,
  );
  return persistedRecord;
}

export function updateClawInstallRecordStatus(
  agentId: string,
  status: ClawInstallStatus,
  options: OpenClawStateDatabaseOptions & {
    nowMs?: number;
    expectedStatuses?: ClawInstallStatus[];
    deletionOperation?: AgentDeletionOperation;
  } = {},
): void {
  runOpenClawStateWriteTransaction((database) => {
    assertAgentDeletionAllowsMutation(database, agentId, options.deletionOperation);
    const { db } = database;
    const expectedStatuses = options.expectedStatuses ?? [];
    let query = getNodeSqliteKysely<ClawProvenanceDatabase>(db)
      .updateTable("claw_installs")
      .set({ status, updated_at_ms: options.nowMs ?? Date.now() })
      .where("agent_id", "=", agentId);
    if (expectedStatuses.length > 0) {
      query = query.where("status", "in", expectedStatuses);
    }
    if (executeSqliteQuerySync(db, query).numAffectedRows !== 1n) {
      throw new Error(
        `Claw install record for agent ${JSON.stringify(agentId)} did not match the expected phase.`,
      );
    }
    options.deletionOperation?.handoffToRetry(database);
  }, options);
}

export function deleteClawInstallRecord(
  agentId: string,
  options: OpenClawStateDatabaseOptions & { expectedStatuses?: ClawInstallStatus[] } = {},
): void {
  runOpenClawStateWriteTransaction((database) => {
    assertAgentDeletionAllowsMutation(database, agentId);
    const { db } = database;
    const expectedStatuses = options.expectedStatuses ?? [];
    let query = getNodeSqliteKysely<ClawProvenanceDatabase>(db)
      .deleteFrom("claw_installs")
      .where("agent_id", "=", agentId);
    if (expectedStatuses.length > 0) {
      query = query.where("status", "in", expectedStatuses);
    }
    if (executeSqliteQuerySync(db, query).numAffectedRows !== 1n) {
      throw new Error(
        `Claw install record for agent ${JSON.stringify(agentId)} did not match the expected phase.`,
      );
    }
  }, options);
  deleteCachedClawInstallSchemaVersion(agentId, options);
}

export function readClawInstallRecords(
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawInstall[] {
  return readClawInstallRecordsInDatabase(openOpenClawStateDatabase(options).db);
}

export function updateClawInstallRecord(
  plan: ClawInstallRecordUpdate,
  options: OpenClawStateDatabaseOptions & {
    nowMs?: number;
    expectedClaw?: { version: string; integrity: string };
    status?: ClawInstallStatus;
    agentConfigDigest?: string;
  } = {},
): PersistedClawInstall {
  const updatedAtMs = options.nowMs ?? Date.now();
  const status = options.status ?? "complete";
  const agentConfigDigest = options.agentConfigDigest ?? digestClawValue(plan.agent.config);
  const ownedAgentPaths = agentOwnedPaths(plan);
  const record = runOpenClawStateWriteTransaction((database) => {
    assertAgentDeletionAllowsMutation(database, plan.agent.finalId);
    const { db } = database;
    const current = readClawInstallRecordFromDatabase(db, plan.agent.finalId);
    if (!current) {
      throw new Error(
        `No Claw install record exists for agent ${JSON.stringify(plan.agent.finalId)}.`,
      );
    }
    const bootstrap = bootstrapProvenance(plan) ?? current.bootstrap;
    const ownership = encodeClawAgentOwnership(ownedAgentPaths, current.agentOrigin);
    const result = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<ClawProvenanceDatabase>(db)
        .updateTable("claw_installs")
        .set({
          schema_version: ownership.schemaVersion,
          source_kind: plan.claw.kind,
          claw_name: plan.claw.name,
          claw_version: plan.claw.version,
          package_root: plan.claw.packageRoot,
          manifest_path: plan.claw.manifestPath,
          integrity_kind: plan.claw.integrityKind,
          integrity: plan.claw.integrity,
          source_byte_length: plan.claw.byteLength,
          manifest_schema_version: plan.manifestSchemaVersion,
          plan_integrity: plan.planIntegrity,
          workspace: plan.agent.workspace,
          agent_config_digest: agentConfigDigest,
          agent_owned_paths_json: ownership.agentOwnedPathsJson,
          bootstrap_source_path: bootstrap?.sourcePath ?? null,
          bootstrap_content_digest: bootstrap?.contentDigest ?? null,
          status,
          updated_at_ms: updatedAtMs,
        })
        .where("agent_id", "=", plan.agent.finalId)
        .where("claw_version", "=", options.expectedClaw?.version ?? current.claw.version)
        .where("integrity", "=", options.expectedClaw?.integrity ?? current.claw.integrity),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error(
        `Claw install record changed for agent ${JSON.stringify(plan.agent.finalId)}.`,
      );
    }
    return {
      schemaVersion: ownership.schemaVersion,
      claw: plan.claw,
      manifestSchemaVersion: plan.manifestSchemaVersion,
      planIntegrity: plan.planIntegrity,
      agentId: plan.agent.finalId,
      workspace: plan.agent.workspace,
      agentConfigDigest,
      agentOrigin: current.agentOrigin,
      agentOwnedPaths: ownedAgentPaths,
      ...(bootstrap ? { bootstrap } : {}),
      status,
      addedAtMs: current.addedAtMs,
      updatedAtMs,
    };
  }, options);
  cacheClawInstallSchemaVersion(
    plan.agent.finalId,
    record.schemaVersion,
    record.agentConfigDigest,
    options,
  );
  return record;
}

export function persistClawPackageRef(
  plan: ClawAddPlan,
  pkg: ResolvedClawPackage,
  options: OpenClawStateDatabaseOptions & {
    nowMs?: number;
    status?: ClawPackageRefStatus;
    relationship?: ClawPackageRelationship;
    origin?: ClawPackageOrigin;
    independentOwner?: boolean;
  } = {},
): PersistedClawPackageRef {
  const nowMs = options.nowMs ?? Date.now();
  let record: PersistedClawPackageRef = {
    schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
    agentId: plan.agent.finalId,
    clawName: plan.claw.name,
    kind: pkg.kind,
    source: pkg.source,
    ref: pkg.ref,
    version: pkg.version,
    integrity: pkg.integrity,
    status: options.status ?? "complete",
    relationship: options.relationship ?? (pkg.kind === "skill" ? "managed" : "referenced"),
    origin: options.origin ?? "claw-introduced",
    independentOwner: options.independentOwner ?? false,
    ...(pkg.extension ? { extension: pkg.extension } : {}),
    installedAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    const existing = db /* sqlite-allow-raw: exact owned package-ref replay lookup. */
      .prepare(
        `SELECT schema_version, agent_id, claw_name, package_kind, package_source,
                package_ref, package_version, package_integrity, package_status, relationship, origin,
                independent_owner, extension_id, extension_format, extension_detected_format,
                extension_mapped_json, extension_unavailable_json, extension_adapter_identity,
                installed_at_ms, updated_at_ms
           FROM claw_package_refs
          WHERE agent_id = @agent_id
            AND package_kind = @package_kind
            AND package_source = @package_source
            AND package_ref = @package_ref
            AND package_version = @package_version`,
      )
      .get({
        agent_id: record.agentId,
        package_kind: record.kind,
        package_source: record.source,
        package_ref: record.ref,
        package_version: record.version,
      }) as PackageRefRow | undefined;
    if (existing) {
      const previous = rowToPackageRef(existing);
      if (previous.integrity !== record.integrity) {
        throw new Error(
          `Claw package reference ${record.kind}:${record.ref}@${record.version} changed integrity from ${previous.integrity} to ${record.integrity}.`,
        );
      }
      record = {
        ...record,
        relationship: previous.relationship,
        origin: previous.origin === "claw-introduced" ? "claw-introduced" : record.origin,
        independentOwner: previous.independentOwner || record.independentOwner,
        installedAtMs: previous.installedAtMs,
      };
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<ClawProvenanceDatabase>(db)
          .updateTable("claw_package_refs")
          .set({
            schema_version: record.schemaVersion,
            claw_name: record.clawName,
            package_status: record.status,
            relationship: record.relationship,
            origin: record.origin,
            independent_owner: record.independentOwner ? 1 : 0,
            ...toPackageRefExtensionSqlParams(record.extension),
            updated_at_ms: record.updatedAtMs,
          })
          .where("agent_id", "=", record.agentId)
          .where("package_kind", "=", record.kind)
          .where("package_source", "=", record.source)
          .where("package_ref", "=", record.ref)
          .where("package_version", "=", record.version)
          .where("package_integrity", "=", record.integrity),
      );
      return;
    }
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<ClawProvenanceDatabase>(db)
        .insertInto("claw_package_refs")
        .values({
          agent_id: record.agentId,
          package_kind: record.kind,
          package_source: record.source,
          package_ref: record.ref,
          package_version: record.version,
          package_integrity: record.integrity,
          schema_version: record.schemaVersion,
          claw_name: record.clawName,
          package_status: record.status,
          relationship: record.relationship,
          origin: record.origin,
          independent_owner: record.independentOwner ? 1 : 0,
          ...toPackageRefExtensionSqlParams(record.extension),
          installed_at_ms: record.installedAtMs,
          updated_at_ms: record.updatedAtMs,
        }),
    );
  }, options);
  return record;
}

export function updateClawPackageRefStatus(
  ref: PersistedClawPackageRef,
  status: ClawPackageRefStatus,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): PersistedClawPackageRef {
  return runOpenClawStateWriteTransaction(
    ({ db }) => updateClawPackageRefStatusInDatabase(db, ref, status, options.nowMs ?? Date.now()),
    options,
  );
}

export function readClawPackageRefs(
  options: OpenClawStateDatabaseOptions & ClawPackageRefQuery = {},
): PersistedClawPackageRef[] {
  return readClawPackageRefsInDatabase(openOpenClawStateDatabase(options).db, options);
}

function upgradeClawInstallSchema(
  database: OpenClawStateDatabase,
  agentId: string,
  record: PersistedClawInstall,
  expectedRecord: PersistedClawInstall | undefined,
  replacement: Pick<PersistedClawInstall, "planIntegrity" | "agentConfigDigest">,
): PersistedClawInstall {
  assertAgentDeletionAllowsMutation(database, agentId);
  if (!expectedRecord || stableStringify(record) !== stableStringify(expectedRecord)) {
    throw new Error(
      `Legacy Claw install record for agent ${JSON.stringify(agentId)} is not an exact resumable attempt.`,
    );
  }
  database.db /* sqlite-allow-raw: exact legacy retry atomically replaces the consent-bound plan identity. */
    .prepare(
      `UPDATE claw_installs
          SET schema_version = ?, plan_integrity = ?, agent_config_digest = ?
        WHERE agent_id = ?`,
    )
    .run(
      installRecordSchema.CLAW_INSTALL_RECORD_SCHEMA_VERSION,
      replacement.planIntegrity,
      replacement.agentConfigDigest,
      agentId,
    );
  return {
    ...record,
    ...replacement,
    schemaVersion: installRecordSchema.CLAW_INSTALL_RECORD_SCHEMA_VERSION,
  };
}
