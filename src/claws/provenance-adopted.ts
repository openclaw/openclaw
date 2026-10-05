import type { DatabaseSync } from "node:sqlite";
import { assertAgentDeletionAllowsMutation } from "../agents/agent-lifecycle-registry.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { digestClawValue } from "./digest.js";
import {
  CLAW_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION,
  encodeClawAgentOwnership,
} from "./provenance-agent-origin.js";
import {
  cacheClawInstallSchemaVersion,
  deleteCachedClawInstallSchemaVersion,
} from "./provenance-runtime-read.js";
import { readClawSecondaryReferenceTables } from "./provenance-secondary-references.js";
import type { PersistedClawInstall } from "./provenance-types.js";
import type { ClawAddPlan } from "./types.js";
import type { PersistedClawWorkspaceFile } from "./workspace.js";

type ClawAdoptedDatabase = Pick<DB, "claw_installs" | "claw_workspace_files">;

function agentOwnedPaths(plan: ClawAddPlan): string[] {
  return plan.actions.filter((action) => action.kind === "agent").map((action) => action.target);
}

/** Atomically records a migration's adopted agent and already-present workspace files. */
export function persistClawMigrationOwnershipWithInstallRecordReader(
  plan: ClawAddPlan,
  workspaceFiles: PersistedClawWorkspaceFile[],
  readInstallRecord: (db: DatabaseSync, agentId: string) => PersistedClawInstall | undefined,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): PersistedClawInstall {
  const nowMs = options.nowMs ?? Date.now();
  const agentConfigDigest = digestClawValue(plan.agent.config);
  const ownedPaths = agentOwnedPaths(plan);
  const ownership = encodeClawAgentOwnership(ownedPaths, "adopted");
  const record = runOpenClawStateWriteTransaction((database) => {
    assertAgentDeletionAllowsMutation(database, plan.agent.finalId);
    const { db } = database;
    if (readInstallRecord(db, plan.agent.finalId)) {
      throw new Error(
        `Agent ${JSON.stringify(plan.agent.finalId)} already has Claw ownership; inspect claws status before migrating.`,
      );
    }
    const secondaryReferences = readClawSecondaryReferenceTables(db, plan.agent.finalId);
    if (secondaryReferences.length > 0) {
      throw new Error(
        `Agent ${JSON.stringify(plan.agent.finalId)} has unclaimed Claw resource references in ${secondaryReferences.join(", ")}; reconcile them before migration.`,
      );
    }
    const existingWorkspaceOwnership = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<ClawAdoptedDatabase>(db)
        .selectFrom("claw_workspace_files")
        .select("target_path")
        .where("agent_id", "=", plan.agent.finalId)
        .limit(1),
    );
    if (existingWorkspaceOwnership) {
      throw new Error(
        `Agent ${JSON.stringify(plan.agent.finalId)} has an unclaimed Claw workspace-file ownership record for ${JSON.stringify(existingWorkspaceOwnership.target_path)}; reconcile it before migration.`,
      );
    }
    for (const file of workspaceFiles) {
      if (
        file.agentId !== plan.agent.finalId ||
        file.workspace !== plan.agent.workspace ||
        file.status !== "complete"
      ) {
        throw new Error("Migration workspace ownership does not match its consented agent plan.");
      }
      const collision = executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<ClawAdoptedDatabase>(db)
          .selectFrom("claw_workspace_files")
          .select("agent_id")
          .where("workspace", "=", file.workspace)
          .where("target_path", "=", file.path)
          .limit(1),
      );
      if (collision) {
        throw new Error(
          `Workspace path ${JSON.stringify(file.path)} is already tracked by Claw agent ${JSON.stringify(collision.agent_id)}.`,
        );
      }
    }
    const state = getNodeSqliteKysely<ClawAdoptedDatabase>(db);
    executeSqliteQuerySync(
      db,
      state.insertInto("claw_installs").values({
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
        bootstrap_source_path: null,
        bootstrap_content_digest: null,
        status: "complete",
        added_at_ms: nowMs,
        updated_at_ms: nowMs,
      }),
    );
    for (const file of workspaceFiles) {
      executeSqliteQuerySync(
        db,
        state.insertInto("claw_workspace_files").values({
          schema_version: file.schemaVersion,
          agent_id: file.agentId,
          workspace: file.workspace,
          target_path: file.path,
          source_path: file.sourcePath,
          content_digest: file.contentDigest,
          status: file.status,
          created_at_ms: file.createdAtMs,
          updated_at_ms: file.updatedAtMs,
        }),
      );
    }
    return {
      schemaVersion: CLAW_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION,
      claw: plan.claw,
      manifestSchemaVersion: plan.manifestSchemaVersion,
      planIntegrity: plan.planIntegrity,
      agentId: plan.agent.finalId,
      workspace: plan.agent.workspace,
      agentConfigDigest,
      agentOrigin: "adopted" as const,
      agentOwnedPaths: ownedPaths,
      status: "complete" as const,
      addedAtMs: nowMs,
      updatedAtMs: nowMs,
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

/** Releases adopted ownership metadata without changing the pre-existing agent or files. */
export function releaseAdoptedClawInstallRecordWithInstallRecordReader(
  agentId: string,
  expectedPlanIntegrity: string,
  readInstallRecord: (db: DatabaseSync, agentId: string) => PersistedClawInstall | undefined,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction((database) => {
    assertAgentDeletionAllowsMutation(database, agentId);
    const { db } = database;
    const record = readInstallRecord(db, agentId);
    if (!record) {
      throw new Error(`No Claw install record exists for agent ${JSON.stringify(agentId)}.`);
    }
    if (
      record.agentOrigin !== "adopted" ||
      record.planIntegrity !== expectedPlanIntegrity ||
      record.status !== "complete"
    ) {
      throw new Error(`Adopted Claw ownership changed for agent ${JSON.stringify(agentId)}.`);
    }
    const secondaryReferences = readClawSecondaryReferenceTables(db, agentId);
    if (secondaryReferences.length > 0) {
      throw new Error(
        `Adopted Claw ownership for agent ${JSON.stringify(agentId)} now includes secondary resources in ${secondaryReferences.join(", ")}; reconcile them before releasing ownership.`,
      );
    }
    const state = getNodeSqliteKysely<ClawAdoptedDatabase>(db);
    executeSqliteQuerySync(
      db,
      state.deleteFrom("claw_workspace_files").where("agent_id", "=", agentId),
    );
    const removed = executeSqliteQuerySync(
      db,
      state
        .deleteFrom("claw_installs")
        .where("agent_id", "=", agentId)
        .where("schema_version", "=", record.schemaVersion)
        .where("plan_integrity", "=", expectedPlanIntegrity),
    );
    if (removed.numAffectedRows !== 1n) {
      throw new Error(`Adopted Claw ownership changed for agent ${JSON.stringify(agentId)}.`);
    }
  }, options);
  deleteCachedClawInstallSchemaVersion(agentId, options);
}
