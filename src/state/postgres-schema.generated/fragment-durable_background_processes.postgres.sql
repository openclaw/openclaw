-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE TABLE "durable_background_processes" (
  "id" text COLLATE "C" NOT NULL,
  "record_json" text COLLATE "C" NOT NULL,
  PRIMARY KEY ("id")
);
