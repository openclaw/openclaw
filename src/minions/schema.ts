import type { DatabaseSync } from "node:sqlite";

export const MINION_SCHEMA_VERSION = 1;

/**
 * Pragmas applied at DB open. WAL + BEGIN IMMEDIATE gives single-writer
 * serialization with concurrent readers. `synchronous = NORMAL` trades a small
 * durability window on host crash for throughput — acceptable for a job queue
 * where the retry machinery recovers anyway.
 */
export const MINION_PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA wal_autocheckpoint = 1000",
  "PRAGMA foreign_keys = ON",
] as const;

const DDL_MINION_META = `
CREATE TABLE IF NOT EXISTS minion_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;
`;

/**
 * minion_jobs — every row is one unit of durable work.
 *
 * Status lifecycle (see src/minions/types.ts MinionJobStatus):
 *   waiting → active → completed | failed → (retry → waiting) | dead
 *   waiting → delayed → waiting
 *   waiting → cancelled (pre-claim)
 *   active → cancelling → cancelled (runtime abort path)
 *   any → paused → waiting
 *   any parent → waiting-children until children drain
 *   (migration-only) → attached → active (resume) | waiting (re-queue) | dead
 *
 * attached is non-claimable by design — only the orphan-detection sweep at
 * gateway startup transitions rows out of it, which prevents the split-brain
 * where an imported live row gets a second subagent spawned for it.
 *
 * Timestamps are INTEGER milliseconds since epoch. Booleans are INTEGER 0/1
 * per SQLite STRICT table rules. JSON-shaped columns are TEXT.
 */
const DDL_MINION_JOBS = `
CREATE TABLE IF NOT EXISTS minion_jobs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL,
  queue               TEXT    NOT NULL DEFAULT 'default',
  status              TEXT    NOT NULL,
  priority            INTEGER NOT NULL DEFAULT 0,
  data                TEXT,

  max_attempts        INTEGER NOT NULL DEFAULT 3,
  attempts_made       INTEGER NOT NULL DEFAULT 0,
  attempts_started    INTEGER NOT NULL DEFAULT 0,
  backoff_type        TEXT    NOT NULL DEFAULT 'exponential',
  backoff_delay       INTEGER NOT NULL DEFAULT 1000,
  backoff_jitter      REAL    NOT NULL DEFAULT 0.25,

  stalled_counter     INTEGER NOT NULL DEFAULT 0,
  max_stalled         INTEGER NOT NULL DEFAULT 2,
  lock_token          TEXT,
  lock_until          INTEGER,

  delay_until         INTEGER,

  parent_job_id       INTEGER REFERENCES minion_jobs(id) ON DELETE SET NULL,
  on_child_fail       TEXT    NOT NULL DEFAULT 'fail_parent',

  tokens_input        INTEGER NOT NULL DEFAULT 0,
  tokens_output       INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read   INTEGER NOT NULL DEFAULT 0,

  depth               INTEGER NOT NULL DEFAULT 0,
  max_children        INTEGER,
  timeout_ms          INTEGER,
  timeout_at          INTEGER,
  remove_on_complete  INTEGER NOT NULL DEFAULT 0,
  remove_on_fail      INTEGER NOT NULL DEFAULT 0,
  idempotency_key     TEXT,

  handler_pid         INTEGER,

  result              TEXT,
  progress            TEXT,
  error_text          TEXT,
  stacktrace          TEXT,

  created_at          INTEGER NOT NULL,
  started_at          INTEGER,
  finished_at         INTEGER,
  updated_at          INTEGER NOT NULL,

  CHECK (parent_job_id IS NULL OR parent_job_id != id),
  CHECK (status IN (
    'waiting','active','completed','failed','delayed','dead',
    'cancelled','waiting-children','paused','attached','cancelling'
  )),
  CHECK (backoff_type IN ('fixed','exponential')),
  CHECK (on_child_fail IN ('fail_parent','remove_dep','ignore','continue')),
  CHECK (remove_on_complete IN (0,1)),
  CHECK (remove_on_fail IN (0,1))
) STRICT;
`;

const DDL_MINION_INBOX = `
CREATE TABLE IF NOT EXISTS minion_inbox (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id   INTEGER NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  sender   TEXT    NOT NULL,
  payload  TEXT,
  sent_at  INTEGER NOT NULL,
  read_at  INTEGER
) STRICT;
`;

const DDL_MINION_ATTACHMENTS = `
CREATE TABLE IF NOT EXISTS minion_attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  filename     TEXT    NOT NULL,
  content_type TEXT    NOT NULL,
  storage_uri  TEXT,
  size_bytes   INTEGER NOT NULL,
  sha256       TEXT    NOT NULL,
  created_at   INTEGER NOT NULL
) STRICT;
`;

/**
 * Partial composite index tailored to the claim query:
 *   SELECT ... FROM minion_jobs
 *    WHERE status = 'waiting'
 *      AND (lock_until IS NULL OR lock_until < :now)
 *      AND (delay_until IS NULL OR delay_until <= :now)
 *    ORDER BY priority DESC, created_at ASC, id ASC
 *    LIMIT 1
 * Keeping the partial filter on status='waiting' keeps the index hot.
 */
const DDL_IDX_CLAIM = `
CREATE INDEX IF NOT EXISTS idx_minion_jobs_claim
  ON minion_jobs(priority DESC, created_at ASC, id ASC)
  WHERE status = 'waiting';
`;

const DDL_IDX_STALLED = `
CREATE INDEX IF NOT EXISTS idx_minion_jobs_stalled
  ON minion_jobs(lock_until)
  WHERE status = 'active';
`;

const DDL_IDX_TIMEOUT = `
CREATE INDEX IF NOT EXISTS idx_minion_jobs_timeout
  ON minion_jobs(timeout_at)
  WHERE status = 'active' AND timeout_at IS NOT NULL;
`;

const DDL_IDX_DELAYED = `
CREATE INDEX IF NOT EXISTS idx_minion_jobs_delayed
  ON minion_jobs(delay_until)
  WHERE status = 'delayed';
`;

const DDL_IDX_PARENT_STATUS = `
CREATE INDEX IF NOT EXISTS idx_minion_jobs_parent_status
  ON minion_jobs(parent_job_id, status);
`;

const DDL_IDX_IDEMPOTENCY = `
CREATE UNIQUE INDEX IF NOT EXISTS uniq_minion_jobs_idempotency
  ON minion_jobs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`;

const DDL_IDX_INBOX_UNREAD = `
CREATE INDEX IF NOT EXISTS idx_minion_inbox_unread
  ON minion_inbox(job_id, sent_at ASC)
  WHERE read_at IS NULL;
`;

const DDL_IDX_ATTACHMENTS_JOB = `
CREATE INDEX IF NOT EXISTS idx_minion_attachments_job
  ON minion_attachments(job_id);
`;

export function applyMinionPragmas(db: DatabaseSync): void {
  for (const pragma of MINION_PRAGMAS) {
    db.exec(pragma);
  }
}

export function ensureMinionSchema(db: DatabaseSync): void {
  db.exec(DDL_MINION_META);
  db.exec(DDL_MINION_JOBS);
  db.exec(DDL_MINION_INBOX);
  db.exec(DDL_MINION_ATTACHMENTS);
  db.exec(DDL_IDX_CLAIM);
  db.exec(DDL_IDX_STALLED);
  db.exec(DDL_IDX_TIMEOUT);
  db.exec(DDL_IDX_DELAYED);
  db.exec(DDL_IDX_PARENT_STATUS);
  db.exec(DDL_IDX_IDEMPOTENCY);
  db.exec(DDL_IDX_INBOX_UNREAD);
  db.exec(DDL_IDX_ATTACHMENTS_JOB);

  const stored = readSchemaVersion(db);
  if (stored === null) {
    writeSchemaVersion(db, MINION_SCHEMA_VERSION);
    return;
  }
  if (stored > MINION_SCHEMA_VERSION) {
    throw new Error(
      `minions schema version ${stored} is newer than this build (${MINION_SCHEMA_VERSION}); upgrade openclaw or roll back the DB.`,
    );
  }
  if (stored < MINION_SCHEMA_VERSION) {
    runMigrations(db, stored, MINION_SCHEMA_VERSION);
    writeSchemaVersion(db, MINION_SCHEMA_VERSION);
  }
}

function readSchemaVersion(db: DatabaseSync): number | null {
  const row = db
    .prepare("SELECT value FROM minion_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  if (!row) {
    return null;
  }
  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function writeSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare(
    "INSERT INTO minion_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(version));
}

function runMigrations(_db: DatabaseSync, _from: number, _to: number): void {
  // Future migrations go here. v1 is the initial schema so no upgrade path yet.
}
