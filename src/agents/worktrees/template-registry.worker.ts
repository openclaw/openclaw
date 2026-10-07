import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import {
  parseStateLeaseProcessOwner,
  readStateLeaseProcessOwnerStatus,
  type StateLeaseProcessOwner,
} from "../../infra/state-lease-process-owner.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { createOpenClawStateSchemaEnsurer } from "../../state/openclaw-state-feature-schema.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
  WorkerOperations,
} from "../../state/worker-operation-registry.js";
import type { WorktreeTemplateRecord } from "./template-registry.js";

type TemplateDatabase = Pick<DB, "worktree_templates" | "state_leases">;
const TEMPLATE_READER_SCOPE = "core:managed-worktrees:template-readers";
const kyselyFor = (db: DatabaseSync) => getNodeSqliteKysely<TemplateDatabase>(db);
const ensureTemplateSchema = createOpenClawStateSchemaEnsurer({
  table: "worktree_templates",
  operationLabel: "agents.worktrees.templates.schema.ensure",
});

function rowToRecord(
  row: Selectable<TemplateDatabase["worktree_templates"]>,
): WorktreeTemplateRecord {
  if (row.status !== "preparing" && row.status !== "ready") {
    throw new Error(`Invalid worktree template status: ${row.status}`);
  }
  return {
    cacheKey: row.cache_key,
    id: row.id,
    repoRoot: row.repo_root,
    commonDir: row.common_dir,
    worktreeRoot: row.worktree_root,
    path: row.path,
    backend: row.backend,
    sourceCommit: row.source_commit,
    contentKey: row.content_key,
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function openTemplateDatabase(context: WorkerOperationContext) {
  const options = { ...context.stateOptions(), database: context.open() };
  ensureTemplateSchema(options);
  return options;
}

function worktreeTemplateMutation<Input, Output>(
  operationLabel: string,
  mutate: (db: DatabaseSync, input: Input) => Output,
) {
  return (input: Input, context: WorkerOperationContext): Output =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const result = mutate(db, input);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return result;
      },
      openTemplateDatabase(context),
      { operationLabel },
    );
}

export const worktreeTemplateOperations = {
  "worktrees.templates.read": ({ cacheKey }: { cacheKey: string }, context) => {
    const { db } = openTemplateDatabase(context).database;
    const row = executeSqliteQuerySync(
      db,
      kyselyFor(db).selectFrom("worktree_templates").selectAll().where("cache_key", "=", cacheKey),
    ).rows[0];
    return row ? rowToRecord(row) : undefined;
  },
  "worktrees.templates.has": (_input: undefined, context) => {
    const { db } = openTemplateDatabase(context).database;
    return (
      executeSqliteQuerySync(
        db,
        kyselyFor(db).selectFrom("worktree_templates").select("cache_key").limit(1),
      ).rows.length > 0
    );
  },
  "worktrees.templates.list": (_input: undefined, context) => {
    const { db } = openTemplateDatabase(context).database;
    return executeSqliteQuerySync(
      db,
      kyselyFor(db)
        .selectFrom("worktree_templates")
        .selectAll()
        .orderBy("last_used_at", "asc")
        .orderBy("id", "asc"),
    ).rows.map(rowToRecord);
  },
  "worktrees.templates.reserve": worktreeTemplateMutation(
    "worktrees.templates.reserve",
    (db, record: WorktreeTemplateRecord & { status: "preparing" }) => {
      executeSqliteQuerySync(
        db,
        kyselyFor(db).insertInto("worktree_templates").values({
          cache_key: record.cacheKey,
          id: record.id,
          repo_root: record.repoRoot,
          common_dir: record.commonDir,
          worktree_root: record.worktreeRoot,
          path: record.path,
          backend: record.backend,
          source_commit: record.sourceCommit,
          content_key: record.contentKey,
          status: record.status,
          created_at: record.createdAt,
          last_used_at: record.lastUsedAt,
        }),
      );
    },
  ),
  "worktrees.templates.ready": worktreeTemplateMutation(
    "worktrees.templates.ready",
    (db, { id, now }: { id: string; now: number }) =>
      executeSqliteQuerySync(
        db,
        kyselyFor(db)
          .updateTable("worktree_templates")
          .set({ status: "ready", last_used_at: now })
          .where("id", "=", id)
          .where("status", "=", "preparing"),
      ).numAffectedRows === 1n,
  ),
  "worktrees.templates.delete": worktreeTemplateMutation(
    "worktrees.templates.delete",
    (db, { id }: { id: string }) =>
      executeSqliteQuerySync(
        db,
        kyselyFor(db).deleteFrom("worktree_templates").where("id", "=", id),
      ).numAffectedRows === 1n,
  ),
  "worktrees.templates.retainReader": worktreeTemplateMutation(
    "worktrees.templates.retainReader",
    (db, input: { id: string; key: string; owner: StateLeaseProcessOwner; unpublish?: true }) => {
      const now = Date.now();
      if (input.unpublish) {
        executeSqliteQuerySync(
          db,
          kyselyFor(db)
            .updateTable("worktree_templates")
            .set({ status: "preparing" })
            .where("id", "=", input.id),
        );
      }
      executeSqliteQuerySync(
        db,
        kyselyFor(db)
          .insertInto("state_leases")
          .values({
            scope: TEMPLATE_READER_SCOPE,
            lease_key: input.key,
            owner: input.key,
            expires_at: null,
            heartbeat_at: null,
            payload_json: JSON.stringify({ owner: input.owner, template: input.id }),
            created_at: now,
            updated_at: now,
          }),
      );
    },
  ),
  "worktrees.templates.releaseReader": worktreeTemplateMutation(
    "worktrees.templates.releaseReader",
    (db, { key }: { key: string }) => {
      executeSqliteQuerySync(
        db,
        kyselyFor(db)
          .deleteFrom("state_leases")
          .where("scope", "=", TEMPLATE_READER_SCOPE)
          .where("lease_key", "=", key)
          .where("owner", "=", key),
      );
    },
  ),
  "worktrees.templates.hasReaders": worktreeTemplateMutation(
    "worktrees.templates.hasReaders",
    (db, { id }: { id: string }) => {
      const k = kyselyFor(db);
      const rows = executeSqliteQuerySync(
        db,
        k
          .selectFrom("state_leases")
          .select(["lease_key", "owner", "payload_json"])
          .where("scope", "=", TEMPLATE_READER_SCOPE),
      ).rows;
      let retained = false;
      for (const row of rows) {
        const payload = safeParseJsonRecord(row.payload_json ?? "");
        if (typeof payload?.template !== "string") {
          throw new Error("Worktree template reader is unreadable; template retained");
        }
        const owner = parseStateLeaseProcessOwner(row.payload_json);
        if (readStateLeaseProcessOwnerStatus(owner) === "dead") {
          executeSqliteQuerySync(
            db,
            k
              .deleteFrom("state_leases")
              .where("scope", "=", TEMPLATE_READER_SCOPE)
              .where("lease_key", "=", row.lease_key)
              .where("owner", "=", row.owner),
          );
        } else if (payload.template === id) {
          retained = true;
        }
      }
      return retained;
    },
  ),
} satisfies WorkerOperationHandlers;

export type WorktreeTemplateWorkerOperations = WorkerOperations<typeof worktreeTemplateOperations>;
