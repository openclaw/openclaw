-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE TABLE "sandbox_persistent_execs" (
  "owner_key" text COLLATE "C" NOT NULL,
  "source_identity" text COLLATE "C" NOT NULL,
  "attempt_id" text COLLATE "C" NOT NULL,
  "owner_json" text COLLATE "C" NOT NULL,
  "backend_id" text COLLATE "C" NOT NULL,
  "backend_target_json" text COLLATE "C" NOT NULL,
  "workspace_binding_json" text COLLATE "C" NOT NULL,
  "container_id" text COLLATE "C" NOT NULL,
  "container_name" text COLLATE "C" NOT NULL,
  "container_started_at" text COLLATE "C" NOT NULL,
  "revision" bigint NOT NULL,
  "phase" text COLLATE "C" NOT NULL,
  "receipt_json" text COLLATE "C",
  "error" text COLLATE "C",
  "created_at_ms" bigint NOT NULL,
  "updated_at_ms" bigint NOT NULL,
  PRIMARY KEY ("owner_key"),
  CHECK (("backend_id" = 'docker')),
  CHECK (("revision" > 0)),
  CHECK (("phase" IN ('reserved', 'prepared', 'running', 'stopping', 'uncertain', 'stopped'))),
  CHECK (("phase" NOT IN ('prepared', 'running')) OR "receipt_json" IS NOT NULL),
  UNIQUE ("attempt_id")
);

CREATE INDEX "idx_sandbox_persistent_execs_container" ON "sandbox_persistent_execs" (("container_id") ASC, ("owner_key") ASC);

CREATE INDEX "idx_sandbox_persistent_execs_container_name" ON "sandbox_persistent_execs" (("container_name") ASC, ("owner_key") ASC);

CREATE INDEX "idx_sandbox_persistent_execs_source" ON "sandbox_persistent_execs" (("source_identity") ASC, ("owner_key") ASC);
