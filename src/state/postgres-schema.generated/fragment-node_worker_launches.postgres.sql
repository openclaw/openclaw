-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE TABLE "node_worker_launches" (
  "launch_id" text COLLATE "C" NOT NULL,
  "plan_hash" text COLLATE "C" NOT NULL,
  "gateway_namespace" text COLLATE "C" NOT NULL,
  "environment_id" text COLLATE "C" NOT NULL,
  "session_id" text COLLATE "C" NOT NULL,
  "owner_epoch" bigint NOT NULL,
  "placement_generation" bigint NOT NULL,
  "run_id" text COLLATE "C" NOT NULL,
  "state" text COLLATE "C" NOT NULL,
  "supervisor_pid" bigint NOT NULL,
  "supervisor_start_time" bigint NOT NULL,
  "worker_pid" bigint,
  "worker_start_time" bigint,
  "result_json" text COLLATE "C",
  "error_text" text COLLATE "C",
  "completed_at_ms" bigint,
  "created_at_ms" bigint NOT NULL,
  "updated_at_ms" bigint NOT NULL,
  PRIMARY KEY ("launch_id"),
  CHECK ((char_length("launch_id") BETWEEN 1 AND 256) AND ("launch_id" IS NOT NULL OR NULL)),
  CHECK ((char_length("plan_hash") = 64) AND ("plan_hash" COLLATE "C" !~ '\A.*[^0-9a-f].*\Z')),
  CHECK ((char_length("gateway_namespace") BETWEEN 1 AND 128) AND ("gateway_namespace" COLLATE "C" !~ '\A.*[^A-Za-z0-9._-].*\Z') AND ("gateway_namespace" COLLATE "C" ~ '\A[A-Za-z0-9].*\Z')),
  CHECK ((char_length("environment_id") BETWEEN 1 AND 256) AND ("environment_id" IS NOT NULL OR NULL)),
  CHECK ((char_length("session_id") BETWEEN 1 AND 256) AND ("session_id" IS NOT NULL OR NULL)),
  CHECK (("owner_epoch" BETWEEN 1 AND 9007199254740991)),
  CHECK (("placement_generation" BETWEEN 0 AND 9007199254740991)),
  CHECK ((char_length("run_id") BETWEEN 1 AND 256) AND ("run_id" IS NOT NULL OR NULL)),
  CHECK (("state" IN ('pending', 'running', 'completed', 'failed', 'interrupted', 'cancelled'))),
  CHECK (("supervisor_pid" BETWEEN 1 AND 2147483647)),
  CHECK (("supervisor_start_time" BETWEEN 0 AND 9007199254740991)),
  CHECK ("worker_pid" IS NULL OR ("worker_pid" BETWEEN 1 AND 2147483647)),
  CHECK ("worker_start_time" IS NULL OR ("worker_start_time" BETWEEN 0 AND 9007199254740991)),
  CHECK ("result_json" IS NULL OR ((octet_length(convert_to("result_json", 'UTF8')) BETWEEN 1 AND 65536) AND ("result_json" IS NOT NULL OR NULL) AND ("result_json" IS JSON))),
  CHECK ("error_text" IS NULL OR ((octet_length(convert_to("error_text", 'UTF8')) BETWEEN 1 AND 4096) AND ("error_text" IS NOT NULL OR NULL) AND (strpos("error_text", '
') = 0) AND (strpos("error_text", '') = 0))),
  CHECK ("completed_at_ms" IS NULL OR ("completed_at_ms" BETWEEN 0 AND 9007199254740991)),
  CHECK (("created_at_ms" BETWEEN 0 AND 9007199254740991)),
  CHECK (("updated_at_ms" BETWEEN "created_at_ms" AND 9007199254740991)),
  CHECK ((("worker_pid" IS NULL) = ("worker_start_time" IS NULL))),
  CHECK ((("state" = 'pending') AND "worker_pid" IS NULL AND "result_json" IS NULL AND "error_text" IS NULL AND "completed_at_ms" IS NULL) OR (("state" = 'running') AND "worker_pid" IS NOT NULL AND "result_json" IS NULL AND "error_text" IS NULL AND "completed_at_ms" IS NULL) OR (("state" = 'completed') AND "result_json" IS NOT NULL AND "error_text" IS NULL AND ("completed_at_ms" BETWEEN "created_at_ms" AND "updated_at_ms")) OR (("state" IN ('failed', 'interrupted', 'cancelled')) AND "result_json" IS NULL AND "error_text" IS NOT NULL AND ("completed_at_ms" BETWEEN "created_at_ms" AND "updated_at_ms")))
);

CREATE INDEX "idx_node_worker_launches_terminal_completed" ON "node_worker_launches" (("completed_at_ms") ASC NULLS FIRST, ("launch_id") ASC NULLS FIRST) WHERE "completed_at_ms" IS NOT NULL;
