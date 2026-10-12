-- Generated lazy feature; create dependencies first.

BEGIN;

SET LOCAL standard_conforming_strings = on;

CREATE TABLE "openclaw_state"."operator_approval_standing_grant_generations" (
  "grant_id" text COLLATE "C" NOT NULL,
  "job_definition_generation" bigint NOT NULL,
  PRIMARY KEY ("grant_id"),
  CHECK (("job_definition_generation" >= 1))
);

CREATE TABLE "openclaw_state"."operator_approval_standing_grants" (
  "grant_id" text COLLATE "C" NOT NULL,
  "minted_by_approval_id" text COLLATE "C" NOT NULL,
  "agent_id" text COLLATE "C" NOT NULL,
  "cron_job_id" text COLLATE "C" NOT NULL,
  "job_config_revision" text COLLATE "C" NOT NULL,
  "operation_binding" text COLLATE "C" NOT NULL,
  "created_at_ms" bigint NOT NULL,
  "expires_at_ms" bigint,
  "revoked_at_ms" bigint,
  "revoked_by" text COLLATE "C",
  "last_used_at_ms" bigint,
  "use_count" bigint NOT NULL DEFAULT 0,
  PRIMARY KEY ("grant_id"),
  CHECK ((char_length("grant_id") > 0)),
  CHECK ((char_length("agent_id") > 0)),
  CHECK ((char_length("cron_job_id") > 0)),
  CHECK ((char_length("job_config_revision") > 0)),
  CHECK ((char_length("operation_binding") > 0)),
  CHECK ("expires_at_ms" IS NULL OR ("expires_at_ms" >= "created_at_ms"))
);

CREATE INDEX "idx_operator_approval_standing_grants_binding" ON "openclaw_state"."operator_approval_standing_grants" (("agent_id") ASC NULLS FIRST, ("cron_job_id") ASC NULLS FIRST, ("operation_binding") ASC NULLS FIRST, ("created_at_ms") DESC NULLS LAST);

ALTER TABLE "openclaw_state"."operator_approval_standing_grant_generations" ADD FOREIGN KEY ("grant_id") REFERENCES "openclaw_state"."operator_approval_standing_grants" ("grant_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "openclaw_state"."operator_approval_standing_grants" ADD FOREIGN KEY ("minted_by_approval_id") REFERENCES "openclaw_state"."operator_approvals" ("approval_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

COMMIT;
