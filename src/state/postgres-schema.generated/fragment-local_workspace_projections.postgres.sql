-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE TABLE "local_workspace_manifest_nodes" (
  "worktree_id" text COLLATE "C" NOT NULL,
  "path" text COLLATE "C" NOT NULL,
  "node_json" text COLLATE "C" NOT NULL,
  PRIMARY KEY ("worktree_id", "path")
);

CREATE TABLE "local_workspace_projections" (
  "worktree_id" text COLLATE "C" NOT NULL,
  "agent_id" text COLLATE "C" NOT NULL,
  "session_key" text COLLATE "C" NOT NULL,
  "session_id" text COLLATE "C" NOT NULL,
  "lifecycle_revision" text COLLATE "C",
  "projection_path" text COLLATE "C" NOT NULL,
  "base_commit" text COLLATE "C" NOT NULL,
  "source_paths_json" text COLLATE "C" NOT NULL,
  "baseline_json" text COLLATE "C",
  "baseline_ref" text COLLATE "C",
  "pending_ref" text COLLATE "C",
  "pending_target" text COLLATE "C",
  "paused_runtimes_json" text COLLATE "C",
  "journal_json" text COLLATE "C",
  "journal_pack" bytea,
  "revision" bigint NOT NULL DEFAULT 0,
  "created_at_ms" bigint NOT NULL,
  "checkpoint_json" text COLLATE "C",
  PRIMARY KEY ("worktree_id"),
  CHECK (("pending_target" IN ('canonical', 'projection'))),
  CHECK ("journal_pack" IS NULL OR (octet_length("journal_pack") <= 268435456)),
  CHECK (("revision" >= 0)),
  CHECK ("baseline_json" IS NULL OR "baseline_ref" IS NOT NULL),
  CHECK ((("journal_json" IS NULL) = ("journal_pack" IS NULL))),
  UNIQUE ("projection_path")
);

ALTER TABLE "local_workspace_manifest_nodes" ADD FOREIGN KEY ("worktree_id") REFERENCES "local_workspace_projections" ("worktree_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;
