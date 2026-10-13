-- Generated lazy feature; create dependencies first.

BEGIN;

SET LOCAL standard_conforming_strings = on;

CREATE TABLE "openclaw_state"."operator_approval_execution_identities" (
  "approval_id" text COLLATE "C" NOT NULL,
  "source_context_id" text COLLATE "C" NOT NULL,
  "source_execution_id" text COLLATE "C" NOT NULL,
  PRIMARY KEY ("approval_id"),
  CHECK ((char_length("source_context_id") BETWEEN 1 AND 256) AND ("source_context_id" = btrim("source_context_id"))),
  CHECK ((char_length("source_execution_id") BETWEEN 1 AND 256) AND ("source_execution_id" = btrim("source_execution_id")))
);

ALTER TABLE "openclaw_state"."operator_approval_execution_identities" ADD FOREIGN KEY ("approval_id") REFERENCES "openclaw_state"."operator_approvals" ("approval_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

COMMIT;
