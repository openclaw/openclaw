-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE TABLE "skill_workshop_activity" (
  "agent_id" text COLLATE "C" NOT NULL,
  "skill_name" text COLLATE "C" NOT NULL,
  "changed_at_ms" bigint NOT NULL,
  PRIMARY KEY ("agent_id", "skill_name")
);
