import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { cronStoreKey } from "./store/key.js";

const MIGRATION_KIND = "cron-legacy-default-owner-handoff";

type CronOwnerHandoffDatabase = Pick<OpenClawStateDatabase, "migration_runs" | "migration_sources">;

export type RetainedLegacyCronOwnerHandoffSnapshot =
  | { agentId: string; status: "pending" | "completed" }
  | undefined;

type RetainedLegacyCronOwnerHandoffMutation = {
  before: RetainedLegacyCronOwnerHandoffSnapshot;
  after: RetainedLegacyCronOwnerHandoffSnapshot;
};

function handoffSourceKey(storeKey: string): string {
  return `${MIGRATION_KIND}:${createHash("sha256").update(storeKey).digest("hex")}`;
}

function handoffRunId(storeKey: string): string {
  return `${handoffSourceKey(storeKey)}:retained`;
}

function reportJson(agentId: string, status: "pending" | "completed"): string {
  return JSON.stringify({
    source: MIGRATION_KIND,
    target: "cron_jobs",
    agentId,
    status,
  });
}

function readAgentIdFromReport(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const rawAgentId = (parsed as { agentId?: unknown }).agentId;
    const agentId =
      typeof rawAgentId === "string" ? normalizeOptionalString(rawAgentId) : undefined;
    return agentId ? normalizeAgentId(agentId) : undefined;
  } catch {
    return undefined;
  }
}

/** Persists the owner needed by the next new-code startup after a cross-process config write. */
function retainLegacyDefaultCronOwnerHandoff(
  db: DatabaseSync,
  storePath: string,
  legacyDefaultAgentId: string,
): void {
  const storeKey = cronStoreKey(storePath);
  const sourceKey = handoffSourceKey(storeKey);
  const runId = handoffRunId(storeKey);
  const agentId = normalizeAgentId(legacyDefaultAgentId);
  const now = Date.now();
  const report = reportJson(agentId, "pending");
  const stateDb = getNodeSqliteKysely<CronOwnerHandoffDatabase>(db);
  executeSqliteQuerySync(
    db,
    stateDb
      .insertInto("migration_runs")
      .values({
        id: runId,
        started_at: now,
        finished_at: null,
        status: "pending",
        report_json: report,
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          started_at: now,
          finished_at: null,
          status: "pending",
          report_json: report,
        }),
      ),
  );
  executeSqliteQuerySync(
    db,
    stateDb
      .insertInto("migration_sources")
      .values({
        source_key: sourceKey,
        migration_kind: MIGRATION_KIND,
        source_path: storeKey,
        target_table: "cron_jobs",
        source_sha256: null,
        source_size_bytes: null,
        source_record_count: null,
        last_run_id: runId,
        status: "pending",
        imported_at: now,
        removed_source: 0,
        report_json: report,
      })
      .onConflict((conflict) =>
        conflict.column("source_key").doUpdateSet({
          migration_kind: MIGRATION_KIND,
          source_path: storeKey,
          target_table: "cron_jobs",
          last_run_id: runId,
          status: "pending",
          imported_at: now,
          removed_source: 0,
          report_json: report,
        }),
      ),
  );
}

/** Persists a handoff receipt before the config writer retires legacy ownership. */
export function retainLegacyDefaultCronOwnerHandoffForStore(
  storePath: string,
  legacyDefaultAgentId: string,
  env: NodeJS.ProcessEnv = process.env,
): RetainedLegacyCronOwnerHandoffMutation {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      // Capture receipt rollback state from the same authoritative transaction
      // that overwrites it; a preflight read can race an epoch-blind writer.
      const before = readLegacyDefaultCronOwnerHandoff(db, storePath);
      retainLegacyDefaultCronOwnerHandoff(db, storePath, legacyDefaultAgentId);
      return { before, after: readLegacyDefaultCronOwnerHandoff(db, storePath) };
    },
    { env },
  );
}

function readLegacyDefaultCronOwnerHandoff(
  db: DatabaseSync,
  storePath: string,
): { agentId: string; status: "pending" | "completed" } | undefined {
  const storeKey = cronStoreKey(storePath);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<CronOwnerHandoffDatabase>(db)
      .selectFrom("migration_sources")
      .select(["migration_kind", "status", "report_json"])
      .where("source_key", "=", handoffSourceKey(storeKey)),
  );
  if (
    row?.migration_kind !== MIGRATION_KIND ||
    (row.status !== "pending" && row.status !== "completed")
  ) {
    return undefined;
  }
  const agentId = readAgentIdFromReport(row.report_json);
  return agentId ? { agentId, status: row.status } : undefined;
}

/** Completed receipts remain readable because pre-upgrade writers cannot be fenced. */
function readRetainedLegacyDefaultCronOwner(
  db: DatabaseSync,
  storePath: string,
): string | undefined {
  return readLegacyDefaultCronOwnerHandoff(db, storePath)?.agentId;
}

/** Reads the retained owner without starting a write transaction. */
export function readRetainedLegacyDefaultCronOwnerForStore(
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return readRetainedLegacyDefaultCronOwner(openOpenClawStateDatabase({ env }).db, storePath);
}

/** Restores the receipt that existed before a rejected config-write handoff. */
export function restoreRetainedLegacyDefaultCronOwnerHandoffInDatabase(
  db: DatabaseSync,
  storePath: string,
  snapshot: RetainedLegacyCronOwnerHandoffSnapshot,
  options?: { expectedCurrent: RetainedLegacyCronOwnerHandoffSnapshot },
): void {
  if (
    options &&
    !isDeepStrictEqual(readLegacyDefaultCronOwnerHandoff(db, storePath), options.expectedCurrent)
  ) {
    throw new Error("cron owner handoff receipt changed after adoption; refusing stale rollback");
  }
  const storeKey = cronStoreKey(storePath);
  const stateDb = getNodeSqliteKysely<CronOwnerHandoffDatabase>(db);
  if (!snapshot) {
    executeSqliteQuerySync(
      db,
      stateDb.deleteFrom("migration_sources").where("source_key", "=", handoffSourceKey(storeKey)),
    );
    executeSqliteQuerySync(
      db,
      stateDb.deleteFrom("migration_runs").where("id", "=", handoffRunId(storeKey)),
    );
    return;
  }
  retainLegacyDefaultCronOwnerHandoff(db, storePath, snapshot.agentId);
  if (snapshot.status === "completed") {
    const now = Date.now();
    const report = reportJson(snapshot.agentId, "completed");
    executeSqliteQuerySync(
      db,
      stateDb
        .updateTable("migration_sources")
        .set({ status: "completed", imported_at: now, removed_source: 1, report_json: report })
        .where("source_key", "=", handoffSourceKey(storeKey)),
    );
    executeSqliteQuerySync(
      db,
      stateDb
        .updateTable("migration_runs")
        .set({ finished_at: now, status: "completed", report_json: report })
        .where("id", "=", handoffRunId(storeKey)),
    );
  }
}

export function restoreRetainedLegacyDefaultCronOwnerHandoffForStore(
  storePath: string,
  snapshot: RetainedLegacyCronOwnerHandoffSnapshot,
  env: NodeJS.ProcessEnv = process.env,
  options?: { expectedCurrent: RetainedLegacyCronOwnerHandoffSnapshot },
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) =>
      restoreRetainedLegacyDefaultCronOwnerHandoffInDatabase(db, storePath, snapshot, options),
    { env },
  );
}

/** Retires a handoff only after a new-code startup has durably consumed its owner. */
export function completeLegacyDefaultCronOwnerHandoff(
  storePath: string,
  legacyDefaultAgentId: string,
  env: NodeJS.ProcessEnv = process.env,
): RetainedLegacyCronOwnerHandoffMutation {
  const storeKey = cronStoreKey(storePath);
  const agentId = normalizeAgentId(legacyDefaultAgentId);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const handoff = readLegacyDefaultCronOwnerHandoff(db, storePath);
      if (handoff?.agentId !== agentId || handoff.status === "completed") {
        return { before: handoff, after: handoff };
      }
      const now = Date.now();
      const report = reportJson(agentId, "completed");
      const stateDb = getNodeSqliteKysely<CronOwnerHandoffDatabase>(db);
      executeSqliteQuerySync(
        db,
        stateDb
          .updateTable("migration_sources")
          .set({ status: "completed", imported_at: now, removed_source: 1, report_json: report })
          .where("source_key", "=", handoffSourceKey(storeKey)),
      );
      executeSqliteQuerySync(
        db,
        stateDb
          .updateTable("migration_runs")
          .set({ finished_at: now, status: "completed", report_json: report })
          .where("id", "=", handoffRunId(storeKey)),
      );
      return { before: handoff, after: readLegacyDefaultCronOwnerHandoff(db, storePath) };
    },
    { env },
  );
}
