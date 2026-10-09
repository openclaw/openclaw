// Scoped standing grants minted by cron-context allow-always approvals.
// The minting operator_approvals row stays the sole authorization owner; a
// grant is derivative correlation that lets the exact approved operation of
// one cron job re-execute without re-prompting while it revalidates.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { stableStringify } from "@openclaw/normalization-core";
import type { Selectable } from "kysely";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import {
  loadedCronStoreFromRows,
  resolveCronJobGrantDefinitionGenerationFloor,
  resolveCronJobGrantDefinitionRevision,
} from "../cron/store/row-codec.js";
import { readCronRunReceiptCurrentFactsInDatabase } from "../cron/store/run-receipt-read.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { buildSystemRunApprovalEnvBinding } from "../infra/system-run-approval-binding.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type {
  CronStandingGrantMintSpec,
  CronStandingGrantLookupInput,
  CronStandingGrantRecord,
  ConsumeCronStandingGrantResult,
  CronStandingGrantListing,
  RevokeCronStandingGrantResult,
} from "./operator-approval-standing-grants.types.js";

const STANDING_GRANT_TABLE = "operator_approval_standing_grants";
const STANDING_GRANT_GENERATION_TABLE = "operator_approval_standing_grant_generations";

// Mirrors the canonical declaration in openclaw-state-schema.sql; the table is
// a first-use lazy additive surface (FIRST_USE_STATE_TABLES) so older readers
// stay valid without it and no schema-version bump is required.
const STANDING_GRANT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS operator_approval_standing_grants (
  grant_id TEXT NOT NULL PRIMARY KEY CHECK (length(grant_id) > 0),
  minted_by_approval_id TEXT NOT NULL
    REFERENCES operator_approvals(approval_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL CHECK (length(agent_id) > 0),
  cron_job_id TEXT NOT NULL CHECK (length(cron_job_id) > 0),
  job_config_revision TEXT NOT NULL CHECK (length(job_config_revision) > 0),
  operation_binding TEXT NOT NULL CHECK (length(operation_binding) > 0),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms >= created_at_ms),
  revoked_at_ms INTEGER,
  revoked_by TEXT,
  last_used_at_ms INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS idx_operator_approval_standing_grants_binding
  ON operator_approval_standing_grants(agent_id, cron_job_id, operation_binding, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS operator_approval_standing_grant_generations (
  grant_id TEXT NOT NULL PRIMARY KEY
    REFERENCES operator_approval_standing_grants(grant_id) ON DELETE CASCADE,
  job_definition_generation INTEGER NOT NULL CHECK (job_definition_generation >= 1)
) STRICT;
`;

type StandingGrantDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "operator_approval_standing_grants"
  | "operator_approval_standing_grant_generations"
  | "operator_approvals"
  | "cron_jobs"
>;

function projectCronStandingGrant(
  row: Selectable<StandingGrantDatabase[typeof STANDING_GRANT_TABLE]>,
): CronStandingGrantRecord {
  return {
    grantId: row.grant_id,
    mintedByApprovalId: row.minted_by_approval_id,
    agentId: row.agent_id,
    cronJobId: row.cron_job_id,
    jobConfigRevision: row.job_config_revision,
    operationBinding: row.operation_binding,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    lastUsedAtMs: row.last_used_at_ms,
    useCount: row.use_count,
  };
}

/**
 * Exact gateway-exec operation binding: trimmed command text, cwd, and the
 * env-override hash. Both mint (approval creation) and use (allowlist
 * evaluation) derive it from the same raw inputs, so matching is byte-exact —
 * the same semantics as systemRunBinding digest matching.
 */
export function buildCronExecOperationBinding(params: {
  command: string;
  cwd: string | null | undefined;
  env: Record<string, string> | undefined;
}): string {
  return stableStringify({
    v: 1,
    command: params.command.trim(),
    cwd: params.cwd?.trim() || null,
    envHash: buildSystemRunApprovalEnvBinding(params.env).envHash,
  });
}

/** Parses a stored operation binding back into its display facts. */
export function parseCronExecOperationBinding(binding: string): {
  command: string;
  cwd: string | null;
} | null {
  try {
    // SAFETY: fields stay unknown; the guards below validate before use.
    const parsed = JSON.parse(binding) as { v?: unknown; command?: unknown; cwd?: unknown };
    if (parsed.v !== 1 || typeof parsed.command !== "string") {
      return null;
    }
    return { command: parsed.command, cwd: typeof parsed.cwd === "string" ? parsed.cwd : null };
  } catch {
    return null;
  }
}

function ensureStandingGrantSchema(db: DatabaseSync): void {
  // Pre-release shape carried a mandatory expiry stamped from a retired fixed
  // TTL. That shape never reached a release tag, and grants are re-derivable
  // authority (dropping one only re-prompts the next occurrence), so rebuild
  // instead of migrating: fail-closed, no data a user can miss.
  if (tableExists(db, STANDING_GRANT_TABLE)) {
    // sqlite-allow-raw -- pragma introspection for the one-time shape check:
    const rawColumns = db.prepare(`PRAGMA table_info(${STANDING_GRANT_TABLE})`).all(); // sqlite-allow-raw
    // SAFETY: PRAGMA table_info rows always carry name/notnull columns.
    const columns = rawColumns as Array<{ name: string; notnull: number }>;
    const legacyMandatoryExpiry = columns.some(
      (column) => column.name === "expires_at_ms" && column.notnull === 1,
    );
    if (legacyMandatoryExpiry) {
      // sqlite-allow-raw -- unshipped-shape rebuild DDL.
      db.exec(`DROP TABLE ${STANDING_GRANT_TABLE};`);
    }
  }
  // sqlite-allow-raw -- first-use additive schema DDL; grant rows use Kysely.
  db.exec(STANDING_GRANT_SCHEMA_SQL);
}

function decodeDefinitionGeneration(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * Mints one standing grant inside the caller's open write transaction — the
 * same transaction that resolves the minting approval to allow-always. A
 * re-mint for the same (agent, job, binding) replaces prior grants.
 */
export function mintCronStandingGrantLocked(
  database: OpenClawStateDatabase,
  params: CronStandingGrantMintSpec & {
    approvalId: string;
    nowMs: number;
    /** Terms freeze at mint: explicit override, else config default, else null (until revoked). */
    expiresAtMs: number | null;
  },
): void {
  ensureStandingGrantSchema(database.db);
  const stateDb = getNodeSqliteKysely<StandingGrantDatabase>(database.db);
  // Expired grants are dead weight; drop them opportunistically at mint time,
  // mirroring the operator-approval prune-on-insert pattern. NULL expiry rows
  // live until revoked or superseded.
  executeSqliteQuerySync(
    database.db,
    stateDb
      .deleteFrom(STANDING_GRANT_TABLE)
      .where("expires_at_ms", "is not", null)
      .where("expires_at_ms", "<=", params.nowMs),
  );
  const jobRows = executeSqliteQuerySync(
    database.db,
    stateDb.selectFrom("cron_jobs").selectAll().where("job_id", "=", params.cronJobId).limit(2),
  ).rows;
  if (jobRows.length !== 1) {
    return;
  }
  const jobRow = jobRows[0]!;
  const loaded = loadedCronStoreFromRows(jobRows);
  const job = loaded.store.jobs.find((entry) => entry.id === params.cronJobId);
  if (!job || resolveCronJobConfigRevision(job) !== params.jobConfigRevision) {
    return;
  }
  const grantDefinitionRevision = resolveCronJobGrantDefinitionRevision(job);
  let jobDefinitionGeneration = decodeDefinitionGeneration(jobRow.grant_definition_generation);
  const projectionStale =
    jobRow.grant_definition_revision !== grantDefinitionRevision ||
    jobRow.grant_definition_updated_at !== jobRow.updated_at;
  if (projectionStale || jobDefinitionGeneration === null) {
    const retainedGenerationFloor = resolveCronJobGrantDefinitionGenerationFloor(
      database.db,
      params.cronJobId,
    );
    jobDefinitionGeneration = decodeDefinitionGeneration(
      Math.max((jobDefinitionGeneration ?? 0) + 1, retainedGenerationFloor),
    );
    if (jobDefinitionGeneration === null) {
      return;
    }
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("cron_jobs")
        .set({
          grant_definition_revision: grantDefinitionRevision,
          grant_definition_generation: jobDefinitionGeneration,
          grant_definition_updated_at: jobRow.updated_at,
        })
        .where("store_key", "=", jobRow.store_key)
        .where("job_id", "=", jobRow.job_id),
    );
  }
  executeSqliteQuerySync(
    database.db,
    stateDb
      .deleteFrom(STANDING_GRANT_TABLE)
      .where("agent_id", "=", params.agentId)
      .where("cron_job_id", "=", params.cronJobId)
      .where("operation_binding", "=", params.operationBinding),
  );
  const grantId = randomUUID();
  executeSqliteQuerySync(
    database.db,
    stateDb.insertInto(STANDING_GRANT_TABLE).values({
      grant_id: grantId,
      minted_by_approval_id: params.approvalId,
      agent_id: params.agentId,
      cron_job_id: params.cronJobId,
      job_config_revision: params.jobConfigRevision,
      operation_binding: params.operationBinding,
      created_at_ms: params.nowMs,
      expires_at_ms: params.expiresAtMs,
      revoked_at_ms: null,
      revoked_by: null,
      last_used_at_ms: null,
      use_count: 0,
    }),
  );
  executeSqliteQuerySync(
    database.db,
    stateDb.insertInto(STANDING_GRANT_GENERATION_TABLE).values({
      grant_id: grantId,
      job_definition_generation: jobDefinitionGeneration,
    }),
  );
}

/** Worker snapshot lookup; only committed consumption authorizes a launch. */
export function lookupCronStandingGrantInDatabase(
  db: DatabaseSync,
  params: CronStandingGrantLookupInput,
  recordUse: boolean,
): ConsumeCronStandingGrantResult {
  return runSqliteDeferredTransactionSync(db, () => {
    if (!tableExists(db, STANDING_GRANT_TABLE)) {
      return { outcome: "no-grant" };
    }
    const nowMs = params.nowMs ?? Date.now();
    const stateDb = getNodeSqliteKysely<StandingGrantDatabase>(db);
    const grant = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom(STANDING_GRANT_TABLE)
        .selectAll()
        .where("agent_id", "=", params.agentId)
        .where("cron_job_id", "=", params.cronJobId)
        .where("operation_binding", "=", params.operationBinding)
        .orderBy("created_at_ms", "desc")
        .orderBy("grant_id", "desc")
        .limit(1),
    );
    if (
      !grant ||
      (params.expectedGrant &&
        (grant.grant_id !== params.expectedGrant.grantId ||
          grant.minted_by_approval_id !== params.expectedGrant.mintedByApprovalId))
    ) {
      return { outcome: "no-grant" };
    }
    if (grant.revoked_at_ms !== null) {
      return { outcome: "revoked" };
    }
    if (grant.expires_at_ms !== null && grant.expires_at_ms <= nowMs) {
      return { outcome: "expired" };
    }
    // The run was started from the current job config; both the run-threaded
    // revision and the authoritative row must equal the revision at mint.
    if (grant.job_config_revision !== params.jobConfigRevision) {
      return { outcome: "job-revision-changed" };
    }
    const jobRows = executeSqliteQuerySync(
      db,
      stateDb.selectFrom("cron_jobs").selectAll().where("job_id", "=", params.cronJobId).limit(2),
    ).rows;
    // Ambiguous multi-store rows fail closed to prompting like a missing job.
    if (jobRows.length !== 1) {
      return { outcome: "job-missing" };
    }
    const loaded = loadedCronStoreFromRows(jobRows);
    const job = loaded.store.jobs.find((entry) => entry.id === params.cronJobId);
    if (!job) {
      return { outcome: "job-missing" };
    }
    if (resolveCronJobConfigRevision(job) !== grant.job_config_revision) {
      return { outcome: "job-revision-changed" };
    }
    const jobRow = jobRows[0]!;
    if (jobRow.grant_definition_revision !== resolveCronJobGrantDefinitionRevision(job)) {
      return { outcome: "job-revision-changed" };
    }
    if (jobRow.grant_definition_updated_at !== jobRow.updated_at) {
      return { outcome: "job-revision-changed" };
    }
    const grantGenerationRow = tableExists(db, STANDING_GRANT_GENERATION_TABLE)
      ? executeSqliteQueryTakeFirstSync(
          db,
          stateDb
            .selectFrom(STANDING_GRANT_GENERATION_TABLE)
            .select("job_definition_generation")
            .where("grant_id", "=", grant.grant_id),
        )
      : undefined;
    const grantGeneration = decodeDefinitionGeneration(
      grantGenerationRow?.job_definition_generation,
    );
    const jobGeneration = decodeDefinitionGeneration(jobRow.grant_definition_generation);
    if (grantGeneration === null || jobGeneration === null || grantGeneration !== jobGeneration) {
      return { outcome: "job-revision-changed" };
    }
    const { handle } = params;
    const facts = readCronRunReceiptCurrentFactsInDatabase(db, {
      type: "cron.currentReceipt",
      handle,
      includeJob: false,
      includeAvailability: true,
    });
    if (
      !isDeepStrictEqual(facts.receipt, handle) ||
      facts.deletionBlocked ||
      handle.agentId !== params.agentId ||
      handle.jobId !== params.cronJobId ||
      handle.storeKey !== jobRow.store_key ||
      handle.configRevision !== params.jobConfigRevision ||
      (job.agentId !== undefined && job.agentId !== handle.agentId)
    ) {
      return { outcome: "receipt-not-current" };
    }
    // Parent reversal fails closed: the approval row is the sole authorization
    // owner, so a pruned/reversed row invalidates its derivative grant.
    const approvalRow = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("operator_approvals")
        .select(["status", "decision"])
        .where("approval_id", "=", grant.minted_by_approval_id),
    );
    if (!approvalRow) {
      return { outcome: "approval-missing" };
    }
    if (approvalRow.status !== "allowed" || approvalRow.decision !== "allow-always") {
      return { outcome: "approval-not-allow-always" };
    }
    if (!recordUse) {
      return {
        outcome: "consumed",
        grant: projectCronStandingGrant(grant),
      };
    }
    const nextUseCount = grant.use_count + 1;
    const updated = executeSqliteQuerySync(
      db,
      stateDb
        .updateTable(STANDING_GRANT_TABLE)
        .set({ last_used_at_ms: nowMs, use_count: nextUseCount })
        .where("grant_id", "=", grant.grant_id)
        .where("revoked_at_ms", "is", null)
        .where((eb) => eb.or([eb("expires_at_ms", "is", null), eb("expires_at_ms", ">", nowMs)])),
    );
    if (updated.numAffectedRows !== 1n) {
      return { outcome: "no-grant" };
    }
    return {
      outcome: "consumed",
      grant: {
        ...projectCronStandingGrant(grant),
        lastUsedAtMs: nowMs,
        useCount: nextUseCount,
      },
    };
  });
}

/** Called only by the existing shared-state writer transaction. */
export function consumeCronStandingGrantInDatabase(
  params: CronStandingGrantLookupInput & {
    recordUse: boolean;
    databaseOptions?: OpenClawStateDatabaseOptions;
  },
): ConsumeCronStandingGrantResult {
  return runOpenClawStateWriteTransaction(
    ({ db }) => lookupCronStandingGrantInDatabase(db, params, params.recordUse),
    params.databaseOptions,
  );
}

/** Includes revoked and expired grants so the operator ledger retains history. */
export function listCronStandingGrantsInDatabase(
  db: DatabaseSync,
  params: { limit?: number } = {},
): CronStandingGrantListing[] {
  const limit = Math.max(1, Math.min(params.limit ?? 200, 500));
  if (!tableExists(db, STANDING_GRANT_TABLE)) {
    return [];
  }
  const stateDb = getNodeSqliteKysely<StandingGrantDatabase>(db);
  const rows = executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom(STANDING_GRANT_TABLE)
      .leftJoin("cron_jobs", "cron_jobs.job_id", "operator_approval_standing_grants.cron_job_id")
      .selectAll(STANDING_GRANT_TABLE)
      .select("cron_jobs.name as cron_job_name")
      .orderBy("operator_approval_standing_grants.created_at_ms", "desc")
      .orderBy("operator_approval_standing_grants.grant_id", "desc")
      .limit(limit),
  ).rows;
  return rows.map((row) =>
    Object.assign(projectCronStandingGrant(row), {
      cronJobName: row.cron_job_name ?? null,
      revokedAtMs: row.revoked_at_ms,
      revokedBy: row.revoked_by,
    }),
  );
}

/** Repeated revocation preserves the original actor and timestamp. */
export function revokeCronStandingGrantInDatabase(params: {
  grantId: string;
  revokedBy: string;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): RevokeCronStandingGrantResult {
  return runOpenClawStateWriteTransaction((database) => {
    if (!tableExists(database.db, STANDING_GRANT_TABLE)) {
      return { outcome: "not-found" };
    }
    const nowMs = params.nowMs ?? Date.now();
    const stateDb = getNodeSqliteKysely<StandingGrantDatabase>(database.db);
    const grant = executeSqliteQueryTakeFirstSync(
      database.db,
      stateDb.selectFrom(STANDING_GRANT_TABLE).selectAll().where("grant_id", "=", params.grantId),
    );
    if (!grant) {
      return { outcome: "not-found" };
    }
    if (grant.revoked_at_ms !== null) {
      return { outcome: "already-revoked" };
    }
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable(STANDING_GRANT_TABLE)
        .set({ revoked_at_ms: nowMs, revoked_by: params.revokedBy })
        .where("grant_id", "=", params.grantId)
        .where("revoked_at_ms", "is", null),
    );
    return {
      outcome: "revoked",
      grant: {
        ...projectCronStandingGrant(grant),
        cronJobName: null,
        revokedAtMs: nowMs,
        revokedBy: params.revokedBy,
      },
    };
  }, params.databaseOptions);
}
