-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE TABLE "outbound_message_execution_bindings" (
  "event_id" text COLLATE "C" NOT NULL,
  "context_id" text COLLATE "C" NOT NULL,
  "execution_id" text COLLATE "C" NOT NULL,
  "run_id" text COLLATE "C" NOT NULL,
  PRIMARY KEY ("event_id"),
  CHECK ((char_length("context_id") BETWEEN 1 AND 256)),
  CHECK ((char_length("execution_id") BETWEEN 1 AND 256)),
  CHECK ((char_length("run_id") BETWEEN 1 AND 256))
);

CREATE INDEX "outbound_message_execution_bindings_execution_event_idx" ON "outbound_message_execution_bindings" (("context_id") ASC, ("execution_id") ASC, ("run_id") ASC, ("event_id") ASC);

ALTER TABLE "outbound_message_execution_bindings" ADD FOREIGN KEY ("event_id") REFERENCES "audit_events" ("event_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;
