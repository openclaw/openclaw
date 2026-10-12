-- Generated lazy feature; create dependencies first.

BEGIN;

SET LOCAL standard_conforming_strings = on;

CREATE TABLE "openclaw_state"."agent_provenance" (
  "agent_id" text COLLATE "C" NOT NULL,
  "created_via" text COLLATE "C" NOT NULL,
  "creator_agent_id" text COLLATE "C",
  "created_at_ms" bigint NOT NULL,
  PRIMARY KEY ("agent_id"),
  CHECK (("created_via" IN ('operator', 'agent', 'claw')))
);

COMMIT;
