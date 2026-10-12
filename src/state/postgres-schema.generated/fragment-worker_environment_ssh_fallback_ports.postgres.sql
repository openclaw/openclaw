-- Generated lazy feature; create dependencies first.

BEGIN;

SET LOCAL standard_conforming_strings = on;

CREATE TABLE "openclaw_state"."worker_environment_ssh_fallback_ports" (
  "environment_id" text COLLATE "C" NOT NULL,
  "position" bigint NOT NULL,
  "port" bigint NOT NULL,
  PRIMARY KEY ("environment_id", "position"),
  CHECK (("position" >= 0) AND ("position" <= 9)),
  CHECK (("port" >= 1) AND ("port" <= 65535)),
  UNIQUE ("environment_id", "port")
);

ALTER TABLE "openclaw_state"."worker_environment_ssh_fallback_ports" ADD FOREIGN KEY ("environment_id") REFERENCES "openclaw_state"."worker_environments" ("environment_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

COMMIT;
