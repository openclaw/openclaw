-- Generated lazy feature; create dependencies first.

BEGIN;

SET LOCAL standard_conforming_strings = on;

CREATE TABLE "openclaw_state"."cron_run_receipts" (
  "receipt_id" text COLLATE "C" NOT NULL,
  "store_key" text COLLATE "C" NOT NULL,
  "job_id" text COLLATE "C" NOT NULL,
  "config_revision" text COLLATE "C" NOT NULL,
  "agent_id" text COLLATE "C" NOT NULL,
  "request_run_id" text COLLATE "C",
  "delivery_attempt_state" text COLLATE "C" NOT NULL DEFAULT 'unknown',
  "status" text COLLATE "C" NOT NULL,
  "owner_pid" bigint NOT NULL,
  "owner_start_time" bigint,
  "started_at_ms" bigint NOT NULL,
  "finished_at_ms" bigint,
  "error_text" text COLLATE "C",
  PRIMARY KEY ("receipt_id"),
  CHECK (("delivery_attempt_state" IN ('unknown', 'not-started', 'started'))),
  CHECK (("status" IN ('running', 'ok', 'error', 'skipped', 'interrupted', 'superseded'))),
  CHECK ((("status" = 'running') AND "finished_at_ms" IS NULL) OR (("status" != 'running') AND "finished_at_ms" IS NOT NULL))
);

CREATE UNIQUE INDEX "idx_cron_run_receipts_active_job" ON "openclaw_state"."cron_run_receipts" (("store_key") ASC NULLS FIRST, ("job_id") ASC NULLS FIRST) WHERE ("status" = 'running');

CREATE INDEX "idx_cron_run_receipts_job_history" ON "openclaw_state"."cron_run_receipts" (("store_key") ASC NULLS FIRST, ("job_id") ASC NULLS FIRST, ("started_at_ms") DESC NULLS LAST, ("receipt_id") DESC NULLS LAST);

COMMIT;
