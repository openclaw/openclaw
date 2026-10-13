-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE TABLE "worktree_templates" (
  "cache_key" text COLLATE "C" NOT NULL,
  "id" text COLLATE "C" NOT NULL,
  "repo_root" text COLLATE "C" NOT NULL,
  "common_dir" text COLLATE "C" NOT NULL,
  "worktree_root" text COLLATE "C" NOT NULL,
  "path" text COLLATE "C" NOT NULL,
  "backend" text COLLATE "C" NOT NULL,
  "source_commit" text COLLATE "C" NOT NULL,
  "content_key" text COLLATE "C" NOT NULL,
  "status" text COLLATE "C" NOT NULL,
  "created_at" bigint NOT NULL,
  "last_used_at" bigint NOT NULL,
  PRIMARY KEY ("cache_key"),
  CHECK (("status" IN ('preparing', 'ready'))),
  UNIQUE ("id")
);
