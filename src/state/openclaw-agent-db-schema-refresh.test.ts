import { describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { withReceiptFixture } from "./agent-validation.test-support.js";
import {
  openOpenClawAgentDatabaseReadOnly,
  hasOpenClawAgentReadOnlySchema,
} from "./openclaw-agent-db-readonly-open.js";
import { stageOpenClawAgentDatabaseSchemaExtension } from "./openclaw-agent-db-schema-extension.worker.js";
import { refreshOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema-refresh.js";
import {
  adoptOpenClawAgentDatabaseSchema,
  captureOpenClawAgentDatabaseReadValidation,
  getOpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";

describe("agent schema refresh", () => {
  it("publishes known derived DDL without repeating agent admission", async () => {
    await withReceiptFixture(false, (database, options) => {
      const reader = openOpenClawAgentDatabaseReadOnly(options);
      if (!reader.found || isPostgresSqlConnection(reader.database.db)) {
        throw new Error("Expected independent SQLite reader");
      }
      const previous = getOpenClawAgentDatabaseValidation(database)!;
      const retainedReader = captureOpenClawAgentDatabaseReadValidation(database);
      expect(retainedReader).toBeDefined();
      try {
        runSqliteImmediateTransactionSync(database.db, () => {
          stageOpenClawAgentDatabaseSchemaExtension(database.db);
          database.db.exec("CREATE TABLE derived_vectors(id TEXT PRIMARY KEY, vector BLOB)");
        });
        const observation = trackSqliteStatementExecutions(database.db, ["sql"], () => "sql");
        const readerObservation = trackSqliteStatementExecutions(
          reader.database.db,
          ["sql"],
          () => "sql",
        );
        try {
          const current = refreshOpenClawAgentDatabaseSchema(database, () => {});
          expect(() => retainedReader!.assertCurrent()).not.toThrow();
          expect(current.valid).toBe(previous.valid);
          expect(current.schema?.facts?.tables.has("derived_vectors")).toBe(true);
          expect(hasOpenClawAgentReadOnlySchema(reader.database)).toBe(true);
          expect(
            getAdmittedSqliteSchemaFacts(reader.database.db)?.tables.has("derived_vectors"),
          ).toBe(true);
          expect(observation.counts.sql).toBe(0);
          expect(readerObservation.counts.sql).toBe(0);
        } finally {
          readerObservation.restore();
          observation.restore();
        }
        // Unclassified DDL still invalidates the agent contract.
        database.db.exec("DROP TABLE derived_vectors");
        expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(false);
        const refreshObservation = trackSqliteStatementExecutions(
          database.db,
          ["catalog"],
          (sql) =>
            sql === "SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY name"
              ? "catalog"
              : null,
        );
        try {
          const refreshed = refreshOpenClawAgentDatabaseSchema(database, () => {});
          expect(refreshed.schema?.facts?.tables.has("derived_vectors")).toBe(false);
          expect(refreshObservation.counts.catalog).toBe(1);
        } finally {
          refreshObservation.restore();
        }
      } finally {
        reader.database.close();
      }
    });
  });
});
