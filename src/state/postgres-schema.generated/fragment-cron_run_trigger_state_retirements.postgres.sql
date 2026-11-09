-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE TABLE "cron_run_trigger_state_retirements" (
  "receipt_id" text COLLATE "C" NOT NULL,
  PRIMARY KEY ("receipt_id")
);

ALTER TABLE "cron_run_trigger_state_retirements" ADD FOREIGN KEY ("receipt_id") REFERENCES "cron_run_receipts" ("receipt_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;
