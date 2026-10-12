-- Generated lazy feature; create dependencies first.

BEGIN;

SET LOCAL standard_conforming_strings = on;

CREATE TABLE "openclaw_state"."node_worker_launch_containers" (
  "launch_id" text COLLATE "C" NOT NULL,
  "container_json" text COLLATE "C",
  PRIMARY KEY ("launch_id")
);

COMMIT;
