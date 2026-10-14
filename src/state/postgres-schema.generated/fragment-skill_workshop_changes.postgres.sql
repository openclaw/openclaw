-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE TABLE "skill_workshop_changes" (
  "cursor_id" bigint NOT NULL,
  "change_id" text COLLATE "C" NOT NULL,
  "agent_id" text COLLATE "C" NOT NULL,
  "skill_name" text COLLATE "C" NOT NULL,
  "action" text COLLATE "C" NOT NULL,
  "actor" text COLLATE "C" NOT NULL,
  "summary" text COLLATE "C" NOT NULL,
  "version_id" text COLLATE "C",
  "session_key" text COLLATE "C",
  "run_id" text COLLATE "C",
  "created_at_ms" bigint NOT NULL,
  PRIMARY KEY ("change_id"),
  CHECK (("action" IN ('create', 'patch', 'write_file', 'remove_file', 'archive', 'restore'))),
  CHECK (("actor" IN ('agent', 'review', 'curator', 'user')))
);

CREATE INDEX "idx_skill_workshop_changes_agent_time" ON "skill_workshop_changes" (("agent_id") ASC NULLS FIRST, ("created_at_ms") ASC NULLS FIRST);

CREATE UNIQUE INDEX "skill_workshop_changes_cursor_id_idx" ON "skill_workshop_changes" (("cursor_id") ASC NULLS FIRST);
