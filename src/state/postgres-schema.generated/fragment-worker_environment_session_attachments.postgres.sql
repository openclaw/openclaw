-- Generated lazy feature; create dependencies first.

BEGIN;

SET LOCAL standard_conforming_strings = on;

CREATE TABLE "openclaw_state"."worker_environment_session_attachments" (
  "session_id" text COLLATE "C" NOT NULL,
  "session_key" text COLLATE "C" NOT NULL,
  "agent_id" text COLLATE "C" NOT NULL,
  "session_lifecycle_revision" text COLLATE "C",
  "environment_id" text COLLATE "C" NOT NULL,
  "generation" bigint NOT NULL,
  "created_at_ms" bigint NOT NULL,
  "last_used_at_ms" bigint NOT NULL,
  "closed_at_ms" bigint,
  PRIMARY KEY ("session_id"),
  CHECK (("generation" >= 1)),
  UNIQUE ("environment_id")
);

CREATE INDEX "worker_environment_session_attachments_session_key" ON "openclaw_state"."worker_environment_session_attachments" (("agent_id") ASC NULLS FIRST, ("session_key") ASC NULLS FIRST);

ALTER TABLE "openclaw_state"."worker_environment_session_attachments" ADD FOREIGN KEY ("environment_id") REFERENCES "openclaw_state"."worker_environments" ("environment_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

COMMIT;
