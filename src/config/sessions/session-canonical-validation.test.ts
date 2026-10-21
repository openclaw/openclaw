import { constants } from "node:sqlite";
import { expect, it } from "vitest";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  loadSessionEntry,
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  markCanonicalSessionValidationPending,
  setCanonicalSqliteSessionMainKey,
} from "./session-canonical-key.js";
import {
  compareAndCertifyCanonicalSessionValidationBatch as certify,
  hasPendingCanonicalSessionValidation as hasPending,
  readPendingCanonicalSessionValidationBatch as readBatch,
  validateCanonicalSessionValidationBatch as validate,
} from "./session-canonical-validation.js";

function withSession(
  run: (scope: { agentId: string; env: NodeJS.ProcessEnv; sessionKey: string }) => void,
  sessionId = "selected",
  entry: Partial<Parameters<typeof replaceSessionEntrySync>[1]> = {},
) {
  return withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = { agentId: "main", env, sessionKey: `agent:main:${sessionId}` };
    replaceSessionEntrySync(scope, { sessionId, updatedAt: 1, ...entry });
    run(scope);
  });
}

it("rejects unvalidated offline repair lineage after closing the writer", async () => {
  await withSession(
    (scope) => {
      expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe("selected");
      const database = openOpenClawAgentDatabase(scope);
      markCanonicalSessionValidationPending(database, [scope.sessionKey]);
      database.db
        .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
        .run("agent:main:other", scope.sessionKey);
      closeOpenClawAgentDatabaseByPath(database.path);
      expect(() => loadSessionEntryReadOnly(scope)).toThrow("openclaw doctor --fix");
    },
    "selected",
    { parentSessionKey: "agent:main:parent" },
  );
});

it("keeps changed rows pending across prepared certification and restores markers on rollback", async () => {
  await withSession((scope) => {
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
    const prepared = validate(readBatch(database, { maxRows: 128, maxBytes: 1024 * 1024 }));
    mutate("newer");
    runOpenClawAgentWriteTransaction((current) => {
      expect(certify(current, prepared)).toBe(0);
      expect(hasPending(current)).toBe(true);
    }, scope);
    const current = validate(readBatch(database, { maxRows: 128, maxBytes: 1024 * 1024 }));
    expect(() =>
      runOpenClawAgentWriteTransaction((writer) => {
        expect(certify(writer, current)).toBe(1);
        expect(hasPending(writer)).toBe(false);
        throw new Error("rollback certification");
      }, scope),
    ).toThrow("rollback certification");
    expect(hasPending(database)).toBe(true);
    runOpenClawAgentWriteTransaction((writer) => {
      expect(certify(writer, current)).toBe(1);
    }, scope);
    expect(loadSessionEntryReadOnly(scope)?.label).toBe("newer");
    expect(hasPending(database)).toBe(false);
  });
});

it("processes an oversized first row alone and preserves the exact validated snapshot", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = { agentId: "main", env, sessionKey: "agent:main:a" };
    for (const id of ["a", "b"]) {
      replaceSessionEntrySync(
        { ...scope, sessionKey: `agent:main:${id}` },
        { sessionId: id, updatedAt: 1, label: "x".repeat(8192) },
      );
    }
    const database = openOpenClawAgentDatabase(scope);
    database.db.exec(
      "INSERT INTO session_canonical_validation_pending SELECT session_key FROM session_nodes",
    );
    const limits = { maxRows: 128, maxBytes: 1024 };
    const batch = readBatch(database, limits);
    expect(batch.rows.map((row) => row.session_key)).toEqual([scope.sessionKey]);
    expect(batch.oversizedRows).toBe(1);
    expect(batch.hasMore).toBe(true);
    const validated = validate(batch);
    batch.rows[0]!.entry_json = "changed after validation";
    runOpenClawAgentWriteTransaction((writer) => {
      expect(certify(writer, validated)).toBe(1);
    }, scope);
    expect(hasPending(database)).toBe(true);
    const next = readBatch(database, limits);
    expect(next.rows.map((row) => row.session_key)).toEqual(["agent:main:b"]);
  });
});

it("does not retain native admission from a rolled-back repair of an unrelated row", async () => {
  await withSession((scope) => {
    replaceSessionEntrySync(
      { ...scope, sessionKey: "agent:main:damaged" },
      { sessionId: "damaged", updatedAt: 1 },
    );
    const seeded = openOpenClawAgentDatabase(scope);
    markCanonicalSessionValidationPending(seeded, ["agent:main:damaged"]);
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
  }, "healthy");
});

it("rejects a divergent serialized identity during an autocommit write", async () => {
  await withSession((scope) => {
    const divergent = {
      sessionId: "serialization",
      updatedAt: 2,
      toJSON: () => ({ sessionId: "other", updatedAt: 2 }),
    };
    expect(() =>
      writeSessionEntry(openOpenClawAgentDatabase(scope), scope.sessionKey, divergent),
    ).toThrow("openclaw doctor --fix");
    expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "serialization", updatedAt: 1 });
    expect(hasPending(openOpenClawAgentDatabase(scope))).toBe(false);
  }, "serialization");
});

it("does not publish an autocommit main-key change when receipt invalidation fails", async () => {
  await withSession((scope) => {
    const database = openOpenClawAgentDatabase(scope);
    const db = requireNativeSqliteDatabase(database.db);
    db.setAuthorizer((action, table, column) => {
      const denied =
        action === constants.SQLITE_UPDATE &&
        table === "session_key_contract" &&
        column === "canonical_ready";
      return denied ? constants.SQLITE_DENY : constants.SQLITE_OK;
    });
    try {
      expect(() => setCanonicalSqliteSessionMainKey(database, "changed-main")).toThrow(/authoriz/u);
    } finally {
      db.setAuthorizer(null);
    }
    expect(
      database.db.prepare("SELECT main_key FROM session_key_contract WHERE id = 1").get(),
    ).toEqual({ main_key: "main" });
  }, "policy");
});
