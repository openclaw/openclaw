import { describe, expect, it, vi } from "vitest";
import { withEngineStoreAdmission as admit } from "../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import { observeStatementEvents } from "../../infra/postgres-sync/sql.test-support.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readPromptCacheRecoveryKeys } from "./session-prompt-cache-recovery.worker.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL prompt-cache recovery", () => {
  useMixedAgentPair("sqlite", "postgres");

  it("buffers at most one page while reading candidate keys in one repeatable snapshot", () => {
    const options = { agentId: "recovery" };
    const key = (n: number) => "agent:recovery:résumé-" + String(n).padStart(3, "0");
    admit(() =>
      runOpenClawAgentWriteTransaction((writer) => {
        for (let n = 0; n < 130; n++) {
          writeSessionEntry(writer, key(n), {
            sessionId: key(n),
            updatedAt: 1,
            lastActivityAt: n % 64 === 0 ? 2 : 1,
          });
        }
      }, options),
    );
    const read = admit(() =>
      withOpenClawAgentDatabaseReadOnly((database) => {
        const db = database.db;
        if (!isPostgresSqlConnection(db)) {
          throw new Error("Expected PostgreSQL fixture");
        }
        const original = db.query.bind(db);
        const pages: number[] = [];
        const capture = vi.spyOn(db, "query").mockImplementation((sql, parameters) => {
          const result = original(sql, parameters);
          if (
            result.columns.some((column) => column.name === "entry_json") &&
            /\blimit\b/i.test(sql)
          ) {
            pages.push(result.rows.length);
          }
          return result;
        });
        try {
          using statements = observeStatementEvents();
          expect(readPromptCacheRecoveryKeys(database, 2)).toEqual([key(0), key(64), key(128)]);
          expect(pages).toEqual([64, 64, 2]);
          expect(
            statements.events.filter((event) =>
              (event as { sql?: string }).sql?.startsWith("BEGIN"),
            ),
          ).toEqual([
            expect.objectContaining({ sql: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" }),
          ]);
        } finally {
          capture.mockRestore();
        }
      }, options),
    );
    expect(read.found).toBe(true);
  });
});
