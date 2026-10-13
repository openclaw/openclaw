-- Generated lazy feature; create dependencies first.

BEGIN;

SET LOCAL standard_conforming_strings = on;

CREATE TABLE "openclaw_state"."projects" (
  "id" text COLLATE "C" NOT NULL,
  "display_name" text COLLATE "C" NOT NULL,
  "repo_root" text COLLATE "C" NOT NULL,
  "origin_url" text COLLATE "C",
  "source" text COLLATE "C" NOT NULL,
  "created_at_ms" bigint NOT NULL,
  "updated_at_ms" bigint NOT NULL,
  PRIMARY KEY ("id"),
  CHECK (("source" IN ('registered', 'cloned')))
);

COMMIT;
