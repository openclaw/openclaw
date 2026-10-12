import { constants } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  loadSessionEntry,
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  markCanonicalSessionValidationPending,
  setCanonicalSqliteSessionMainKey,
} from "./session-canonical-key.js";
import {
  compareAndCertifyCanonicalSessionValidationBatch,
  hasPendingCanonicalSessionValidation,
  readPendingCanonicalSessionValidationBatch,
  validateCanonicalSessionValidationBatch,
} from "./session-canonical-validation.js";

it("reuses canonical readiness until an in-process repair invalidates it", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = { agentId: "main", env, sessionKey: "agent:main:selected" };
    replaceSessionEntrySync(scope, {
      sessionId: "selected",
      updatedAt: 1,
      parentSessionKey: "agent:main:parent",
    });
    const writer = openOpenClawAgentDatabase(scope);
    const opened = openOpenClawAgentDatabaseReadOnly(scope);
    if (!opened.found) {
      throw new Error("Expected the existing session database");
    }
    const reader = opened.database;
    const statements = trackSqliteStatementExecutions(reader.db, ["pending"], (query) =>
      query.includes('"session_canonical_validation_pending"') ? "pending" : null,
    );
    try {
      assertCanonicalSqliteSessionKeysCurrent(reader);
      assertCanonicalSqliteSessionKeysCurrent(reader);
      expect(statements.counts.pending).toBe(0);

      markCanonicalSessionValidationPending(writer, [scope.sessionKey]);
      writer.db
        .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
        .run("agent:main:other", scope.sessionKey);
      expect(() => assertCanonicalSqliteSessionKeysCurrent(reader)).toThrow(
        "openclaw doctor --fix",
      );
    } finally {
      statements.restore();
      reader.close();
    }
  });
});

it("reads a certified session after closing its writer without decoding unrelated entries", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = { agentId: "main", env, sessionKey: "agent:main:selected" };
    replaceSessionEntrySync(scope, { sessionId: "selected", updatedAt: 1 });
    replaceSessionEntrySync(
      { ...scope, sessionKey: "agent:main:unrelated" },
      {
        sessionId: "unrelated",
        updatedAt: 1,
        skillsSnapshot: { prompt: "unrelated-prompt".repeat(8192), skills: [] },
      },
    );
    const database = openOpenClawAgentDatabase(scope);
    closeOpenClawAgentDatabaseByPath(database.path);
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe("selected");
      expect(
        parse.mock.calls.filter(([value]) => value.includes('"sessionId":"unrelated"')),
      ).toHaveLength(0);
    } finally {
      parse.mockRestore();
    }
  });
});

it.each([false, true])(
  "rejects unvalidated offline repair lineage on each fresh committed view (writer closed: %s)",
  async (reopen) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = { agentId: "main", env, sessionKey: "agent:main:selected" };
      replaceSessionEntrySync(scope, {
        sessionId: "selected",
        updatedAt: 1,
        parentSessionKey: "agent:main:parent",
      });
      expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe("selected");
      const database = openOpenClawAgentDatabase(scope);
      markCanonicalSessionValidationPending(database, [scope.sessionKey]);
      database.db
        .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
        .run("agent:main:other", scope.sessionKey);
      if (reopen) {
        closeOpenClawAgentDatabaseByPath(database.path);
      }
      if (!reopen) {
        database.db.exec("BEGIN IMMEDIATE");
      }
      try {
        expect(() => loadSessionEntryReadOnly(scope)).toThrow("openclaw doctor --fix");
      } finally {
        if (!reopen) {
          database.db.exec("ROLLBACK");
        }
      }
    });
  },
);

it("keeps changed rows pending across prepared certification and restores markers on rollback", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = { agentId: "main", env, sessionKey: "agent:main:selected" };
    replaceSessionEntrySync(scope, { sessionId: "selected", updatedAt: 1 });
    const database = openOpenClawAgentDatabase(scope);
    const mutate = (label: string) => {
      markCanonicalSessionValidationPending(database, [scope.sessionKey]);
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(JSON.stringify({ sessionId: "selected", updatedAt: 1, label }), scope.sessionKey);
      database.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(scope.sessionKey);
    };
    mutate("prepared");
    const prepared = validateCanonicalSessionValidationBatch(
      readPendingCanonicalSessionValidationBatch(database, { maxRows: 128, maxBytes: 1024 * 1024 }),
    );
    mutate("newer");
    runOpenClawAgentWriteTransaction((current) => {
      expect(compareAndCertifyCanonicalSessionValidationBatch(current, prepared)).toBe(0);
      expect(hasPendingCanonicalSessionValidation(current)).toBe(true);
    }, scope);
    const current = validateCanonicalSessionValidationBatch(
      readPendingCanonicalSessionValidationBatch(database, { maxRows: 128, maxBytes: 1024 * 1024 }),
    );
    expect(() =>
      runOpenClawAgentWriteTransaction((writer) => {
        expect(compareAndCertifyCanonicalSessionValidationBatch(writer, current)).toBe(1);
        expect(hasPendingCanonicalSessionValidation(writer)).toBe(false);
        throw new Error("rollback certification");
      }, scope),
    ).toThrow("rollback certification");
    expect(hasPendingCanonicalSessionValidation(database)).toBe(true);
    runOpenClawAgentWriteTransaction((writer) => {
      expect(compareAndCertifyCanonicalSessionValidationBatch(writer, current)).toBe(1);
    }, scope);
    expect(loadSessionEntryReadOnly(scope)?.label).toBe("newer");
    expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
  });
});

it("processes an oversized first row alone and preserves the exact validated snapshot", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = { agentId: "main", env, sessionKey: "agent:main:a" };
    for (const id of ["a", "b"]) {
      replaceSessionEntrySync(
        { ...scope, sessionKey: `agent:main:${id}` },
        {
          sessionId: id,
          updatedAt: 1,
          label: "x".repeat(8192),
        },
      );
    }
    const database = openOpenClawAgentDatabase(scope);
    database.db.exec(
      "INSERT INTO session_canonical_validation_pending SELECT session_key FROM session_nodes",
    );
    const batch = readPendingCanonicalSessionValidationBatch(database, {
      maxRows: 128,
      maxBytes: 1024,
    });
    expect(batch.rows.map((row) => row.session_key)).toEqual([scope.sessionKey]);
    expect(batch.oversizedRows).toBe(1);
    expect(batch.hasMore).toBe(true);
    const validated = validateCanonicalSessionValidationBatch(batch);
    batch.rows[0]!.entry_json = "changed after validation";
    runOpenClawAgentWriteTransaction((writer) => {
      expect(compareAndCertifyCanonicalSessionValidationBatch(writer, validated)).toBe(1);
    }, scope);
    expect(hasPendingCanonicalSessionValidation(database)).toBe(true);
    const next = readPendingCanonicalSessionValidationBatch(database, {
      maxRows: 128,
      maxBytes: 1024,
    });
    expect(next.rows.map((row) => row.session_key)).toEqual(["agent:main:b"]);
  });
});

it("does not retain native admission from a rolled-back repair of an unrelated row", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = { agentId: "main", env, sessionKey: "agent:main:healthy" };
    replaceSessionEntrySync(scope, { sessionId: "healthy", updatedAt: 1 });
    replaceSessionEntrySync(
      { ...scope, sessionKey: "agent:main:damaged" },
      { sessionId: "damaged", updatedAt: 1 },
    );
    const seeded = openOpenClawAgentDatabase(scope);
    seeded.db.exec(
      "UPDATE session_nodes SET entry_json = '{' WHERE session_key = 'agent:main:damaged'; UPDATE session_nodes SET entry_valid = 1 WHERE session_key = 'agent:main:damaged'",
    );
    closeOpenClawAgentDatabasesForTest();
    openOpenClawAgentDatabase(scope);
    expect(() =>
      runOpenClawAgentWriteTransaction((database) => {
        database.db
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run(JSON.stringify({ sessionId: "damaged", updatedAt: 1 }), "agent:main:damaged");
        database.db.exec(
          "UPDATE session_nodes SET entry_valid = 1 WHERE session_key = 'agent:main:damaged'",
        );
        expect(loadSessionEntry(scope)?.sessionId).toBe("healthy");
        throw new Error("abandoned repair");
      }, scope),
    ).toThrow("abandoned repair");
    expect(() => loadSessionEntry(scope)).toThrow("openclaw doctor --fix");
  });
});

it.each([
  { kind: "serialized identity", transaction: true },
  { kind: "native text conversion", transaction: true },
  { kind: "serialized identity", transaction: false },
  { kind: "native text conversion", transaction: false },
])(
  "rejects a divergent canonical projection through $kind (transaction: $transaction)",
  async ({ kind, transaction }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = { agentId: "main", env, sessionKey: "agent:main:serialization" };
      replaceSessionEntrySync(scope, { sessionId: "serialization", updatedAt: 1 });
      const divergent =
        kind === "serialized identity"
          ? {
              sessionId: "serialization",
              updatedAt: 2,
              toJSON: () => ({ sessionId: "other", updatedAt: 2 }),
            }
          : {
              sessionId: "serialization",
              updatedAt: 2,
              parentSessionKey: "agent:main:parent-" + String.fromCharCode(0xd800),
            };
      const write = (database: ReturnType<typeof openOpenClawAgentDatabase>) =>
        writeSessionEntry(database, scope.sessionKey, divergent);
      expect(() =>
        transaction
          ? runOpenClawAgentWriteTransaction(write, scope)
          : write(openOpenClawAgentDatabase(scope)),
      ).toThrow("openclaw doctor --fix");
      expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "serialization", updatedAt: 1 });
      expect(hasPendingCanonicalSessionValidation(openOpenClawAgentDatabase(scope))).toBe(false);
    });
  },
);

it.each([true, false])(
  "writes canonical rows without pending work or readback (transaction: %s)",
  async (transaction) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = { agentId: "main", env, sessionKey: "agent:main:writer" };
      const previous = { sessionId: "writer", updatedAt: 1, label: "before" };
      replaceSessionEntrySync(scope, previous);
      const database = openOpenClawAgentDatabase(scope);
      const write = (writer: typeof database) => {
        const statements = trackSqliteStatementExecutions(
          writer.db,
          ["pending", "readback", "validity"] as const,
          (query) => {
            if (query.includes('"session_canonical_validation_pending"')) {
              return "pending";
            }
            if (query.includes('as "retained_window"')) {
              return "readback";
            }
            return query.startsWith('update "session_nodes" set "entry_valid"') ? "validity" : null;
          },
        );
        try {
          writeSessionEntry(
            writer,
            scope.sessionKey,
            { ...previous, updatedAt: 2, label: "after" },
            { canonicalPreviousEntry: previous },
          );
          expect(statements.counts).toEqual({ pending: 0, readback: 0, validity: 0 });
        } finally {
          statements.restore();
        }
      };
      if (transaction) {
        runOpenClawAgentWriteTransaction(write, scope);
      } else {
        write(database);
      }
      expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: "writer",
        updatedAt: 2,
        label: "after",
      });
    });
  },
);

it.each(["pending", "receipt"] as const)(
  "does not publish an autocommit main-key change when %s invalidation fails",
  async (blocked) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = { agentId: "main", env, sessionKey: "agent:main:policy" };
      replaceSessionEntrySync(scope, { sessionId: "policy", updatedAt: 1 });
      const database = openOpenClawAgentDatabase(scope);
      database.db.setAuthorizer((action, table, column) => {
        const denied =
          blocked === "pending"
            ? action === constants.SQLITE_INSERT && table === "session_canonical_validation_pending"
            : action === constants.SQLITE_UPDATE &&
              table === "session_key_contract" &&
              column === "canonical_ready";
        return denied ? constants.SQLITE_DENY : constants.SQLITE_OK;
      });
      try {
        expect(() => setCanonicalSqliteSessionMainKey(database, "changed-main")).toThrow(
          /authoriz/u,
        );
      } finally {
        database.db.setAuthorizer(null);
      }
      expect(
        database.db.prepare("SELECT main_key FROM session_key_contract WHERE id = 1").get(),
      ).toEqual({ main_key: "main" });
    });
  },
);
