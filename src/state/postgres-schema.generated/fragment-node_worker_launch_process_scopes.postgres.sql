-- Generated lazy feature; create dependencies first.

BEGIN;

SET LOCAL standard_conforming_strings = on;

CREATE TABLE "openclaw_state"."node_worker_launch_process_scopes" (
  "launch_id" text COLLATE "C" NOT NULL,
  "scope_kind" text COLLATE "C" NOT NULL,
  "descendants_reaped" bigint,
  PRIMARY KEY ("launch_id"),
  CHECK (("scope_kind" = 'linux-subreaper')),
  CHECK ("descendants_reaped" IS NULL OR ("descendants_reaped" = 1))
);

ALTER TABLE "openclaw_state"."node_worker_launch_process_scopes" ADD FOREIGN KEY ("launch_id") REFERENCES "openclaw_state"."node_worker_launches" ("launch_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

COMMIT;
