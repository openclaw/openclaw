-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE TABLE "agent_deletion_journal" (
  "agent_id" text COLLATE "C" NOT NULL,
  "operation_id" text COLLATE "C" NOT NULL DEFAULT '',
  "phase" text COLLATE "C",
  "agent_dir" text COLLATE "C" NOT NULL,
  "workspace_dir" text COLLATE "C" NOT NULL,
  "sessions_dir" text COLLATE "C" NOT NULL,
  "database_paths_json" text COLLATE "C" NOT NULL DEFAULT '[]',
  "cleanup_paths_json" text COLLATE "C" NOT NULL DEFAULT '[]',
  "created_at" bigint NOT NULL,
  "cleanup_completed" bigint NOT NULL DEFAULT 0,
  "delete_files" bigint NOT NULL DEFAULT 1,
  PRIMARY KEY ("agent_id")
);
