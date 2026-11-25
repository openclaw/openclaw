-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE TABLE "cron_job_runtime_authorities" (
  "store_key" text COLLATE "C" NOT NULL,
  "job_id" text COLLATE "C" NOT NULL,
  "authority_json" text COLLATE "C",
  "authority_input_fingerprint" text COLLATE "C",
  "recovery_required" bigint NOT NULL,
  PRIMARY KEY ("store_key", "job_id"),
  CHECK (("recovery_required" IN (0, 1))),
  CHECK ((("recovery_required" = 0) AND "authority_json" IS NOT NULL AND "authority_input_fingerprint" IS NOT NULL) OR (("recovery_required" = 1) AND "authority_json" IS NULL AND "authority_input_fingerprint" IS NULL))
);

ALTER TABLE "cron_job_runtime_authorities" ADD FOREIGN KEY ("store_key", "job_id") REFERENCES "cron_jobs" ("store_key", "job_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;
