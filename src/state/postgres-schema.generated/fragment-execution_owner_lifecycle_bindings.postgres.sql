-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE TABLE "execution_owner_lifecycle_bindings" (
  "owner_kind" text COLLATE "C" NOT NULL,
  "owner_id" text COLLATE "C" NOT NULL,
  "context_id" text COLLATE "C" NOT NULL,
  "execution_id" text COLLATE "C" NOT NULL,
  PRIMARY KEY ("owner_kind", "owner_id")
);
