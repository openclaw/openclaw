-- Generated lazy feature; create dependencies first.

BEGIN;

SET LOCAL standard_conforming_strings = on;

CREATE TABLE "openclaw_state"."node_worker_launch_boots" (
  "launch_id" text COLLATE "C" NOT NULL,
  "boot_id" text COLLATE "C",
  PRIMARY KEY ("launch_id"),
  CHECK ("boot_id" IS NULL OR (char_length("boot_id") BETWEEN 1 AND 128))
);

ALTER TABLE "openclaw_state"."node_worker_launch_boots" ADD FOREIGN KEY ("launch_id") REFERENCES "openclaw_state"."node_worker_launches" ("launch_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

COMMIT;
