import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import { insertGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.js";
import type { PersonalPublicationSelector } from "../state/github-publication-worker.types.js";
import { ensurePersonalGitHubPublicationSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolvePersonalGitHubOwner } from "../state/user-github-connections.js";
import { personalGitHubRequestDigest } from "./github-personal-publication-store.js";
import { projectGitHubPublicationResult } from "./github-publication-receipt.js";

export type PersonalGitHubPublicationRow = DB["github_personal_publication_requests"];
const table = "github_personal_publication_requests";
const query = (db: Parameters<typeof getNodeSqliteKysely>[0]) =>
  getNodeSqliteKysely<Pick<DB, typeof table>>(db);

function assertOwner(db: DatabaseSync, owner: string): void {
  if (resolvePersonalGitHubOwner(owner, db) !== owner) {
    throw new Error("My GitHub publication owner changed.");
  }
}

export function readPersonalGitHubPublicationInDatabase(
  db: DatabaseSync,
  owner: string,
  request: PersonalPublicationSelector,
): PersonalGitHubPublicationRow | undefined {
  assertOwner(db, owner);
  if (!tableExists(db, table)) {
    return undefined;
  }
  let selection = query(db).selectFrom(table).selectAll().where("owner_profile_id", "=", owner);
  selection =
    "requestId" in request
      ? selection.where("request_id", "=", request.requestId)
      : "sessionId" in request
        ? selection
            .where("session_id", "=", request.sessionId)
            .where("idempotency_key", "=", request.idempotencyKey)
        : selection
            .where("session_key", "=", request.sessionKey)
            .where("agent_id", "=", request.agentId)
            .where("status", "in", ["requested", "publishing", "needs_confirmation"])
            .orderBy("created_at_ms", "desc")
            .orderBy("request_id", "desc")
            .limit(1);
  const row = executeSqliteQueryTakeFirstSync(db, selection);
  if (
    row &&
    (row.identity_source !== "personal" || row.request_digest !== personalGitHubRequestDigest(row))
  ) {
    throw new Error("My GitHub publication receipt is corrupt; create a new publication request.");
  }
  return row;
}

export function insertPersonalGitHubPublicationInDatabase(
  database: OpenClawStateDatabase,
  row: PersonalGitHubPublicationRow,
  lifecycleRevision: string | null,
  assertCurrent: () => void,
): PersonalGitHubPublicationRow {
  const { db } = database;
  assertCurrent();
  assertOwner(db, row.owner_profile_id);
  ensurePersonalGitHubPublicationSchema(db);
  executeSqliteQuerySync(db, query(db).insertInto(table).values(row));
  insertGitHubPublicationSessionLifecycle(db, {
    publicationKind: "personal",
    requestId: row.request_id,
    lifecycleRevision,
  });
  githubPublicationReceipts.stageRow(db, "personal", row);
  return row;
}

export function claimPersonalGitHubPublicationInDatabase(
  database: OpenClawStateDatabase,
  row: PersonalGitHubPublicationRow,
  instanceId: string,
  executionId: string,
  assertCurrent: () => void,
) {
  const { db } = database;
  assertCurrent();
  assertOwner(db, row.owner_profile_id);
  const update = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set({
        status: "publishing",
        gateway_instance_id: instanceId,
        execution_id: executionId,
        updated_at_ms: Date.now(),
      })
      .where("owner_profile_id", "=", row.owner_profile_id)
      .where("request_id", "=", row.request_id)
      .where("request_digest", "=", row.request_digest)
      .where("status", "=", row.status)
      .where("execution_id", row.execution_id === null ? "is" : "=", row.execution_id)
      .returningAll(),
  );
  if (!update) {
    throw new Error("My GitHub publication execution changed.");
  }
  if (
    update.identity_source !== "personal" ||
    update.request_digest !== personalGitHubRequestDigest(update)
  ) {
    throw new Error("My GitHub publication receipt changed during execution.");
  }
  githubPublicationReceipts.stageRow(db, "personal", update);
  return { ...update, gateway_instance_id: instanceId, execution_id: executionId };
}

/** One execution closure owns writes; a later socket must explicitly confirm before claiming. */
export function writePersonalGitHubPublicationInDatabase(
  database: OpenClawStateDatabase,
  row: PersonalGitHubPublicationRow,
  instanceId: string,
  executionId: string,
  values: Partial<PersonalGitHubPublicationRow>,
  requireAction: boolean,
  assertCurrent: () => void,
): PersonalGitHubPublicationRow {
  const { db } = database;
  if (requireAction) {
    assertCurrent();
  }
  const updated = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set({ ...values, updated_at_ms: Date.now() })
      .where("owner_profile_id", "=", row.owner_profile_id)
      .where("request_id", "=", row.request_id)
      .where("request_digest", "=", row.request_digest)
      .where("status", "=", "publishing")
      .where("gateway_instance_id", "=", instanceId)
      .where("execution_id", "=", executionId)
      .returningAll(),
  );
  if (!updated) {
    throw new Error("My GitHub publication execution is no longer current.");
  }
  githubPublicationReceipts.stageRow(db, "personal", updated);
  return updated;
}

export function requirePersonalGitHubPublicationConfirmationInDatabase(
  database: OpenClawStateDatabase,
  instanceId: string,
): PersonalGitHubPublicationRow[] {
  if (!tableExists(database.db, table)) {
    return [];
  }
  const { db } = database;
  const rows = executeSqliteQuerySync(
    db,
    query(db)
      .updateTable(table)
      .set({ status: "needs_confirmation", updated_at_ms: Date.now() })
      .where("status", "in", ["requested", "publishing"])
      .where((eb) =>
        eb.or([eb("gateway_instance_id", "is", null), eb("gateway_instance_id", "!=", instanceId)]),
      )
      .returningAll(),
  ).rows;
  for (const row of rows) {
    githubPublicationReceipts.stageRow(db, "personal", row);
  }
  return rows;
}

export function listUnreportedPersonalGitHubPublicationsInDatabase(db: DatabaseSync) {
  if (!tableExists(db, table)) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom(table)
      .selectAll()
      .where("status", "in", ["published", "failed"])
      .where("reported_at_ms", "is", null)
      .orderBy("updated_at_ms"),
  ).rows.map((row) => {
    if (row.request_digest !== personalGitHubRequestDigest(row)) {
      throw new Error(
        "My GitHub publication receipt is corrupt; reconnect and create a new request.",
      );
    }
    return {
      sessionId: row.session_id,
      sessionKey: row.session_key,
      agentId: row.agent_id,
      result: projectGitHubPublicationResult(row),
    };
  });
}

export function markPersonalGitHubPublicationReportedInDatabase(
  database: OpenClawStateDatabase,
  requestId: string,
): PersonalGitHubPublicationRow | undefined {
  if (!tableExists(database.db, table)) {
    return undefined;
  }
  const { db } = database;
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set({ reported_at_ms: Date.now() })
      .where("request_id", "=", requestId)
      .where("status", "in", ["published", "failed"])
      .returningAll(),
  );
  if (row) {
    githubPublicationReceipts.stageRow(db, "personal", row);
  }
  return row;
}
