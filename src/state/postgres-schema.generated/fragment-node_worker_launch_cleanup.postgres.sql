-- Generated lazy feature; create dependencies first.

BEGIN;

SET LOCAL standard_conforming_strings = on;

CREATE TABLE "openclaw_state"."node_worker_launch_cleanup" (
  "launch_id" text COLLATE "C" NOT NULL,
  "cleanup_mode" text COLLATE "C" NOT NULL,
  "lineage_settled" bigint,
  PRIMARY KEY ("launch_id"),
  CHECK (("cleanup_mode" IN ('process-group', 'owned-anchor'))),
  CHECK ("lineage_settled" IS NULL OR ("lineage_settled" = 1))
);

ALTER TABLE "openclaw_state"."node_worker_launch_cleanup" ADD FOREIGN KEY ("launch_id") REFERENCES "openclaw_state"."node_worker_launches" ("launch_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

COMMIT;
