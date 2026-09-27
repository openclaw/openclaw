import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
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
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  compareAndCertifyCanonicalSessionValidationBatch,
  hasPendingCanonicalSessionValidation,
  readPendingCanonicalSessionValidationBatch,
  validateCanonicalSessionValidationBatch,
} from "./session-canonical-validation.js";

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
  "rejects raw lineage changes on each fresh committed view (writer closed: %s)",
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
      const external = new DatabaseSync(database.path);
      try {
        external
          .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
          .run("agent:main:other", scope.sessionKey);
      } finally {
        external.close();
      }
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
          skillsSnapshot: { prompt: "x".repeat(8192), skills: [] },
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

it.each(["serialized identity", "native text conversion"])(
  "rolls back a writer whose canonical projection diverges through %s",
  async (kind) => {
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
      expect(() =>
        runOpenClawAgentWriteTransaction((database) => {
          writeSessionEntry(database, scope.sessionKey, divergent);
        }, scope),
      ).toThrow("openclaw doctor --fix");
      expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "serialization", updatedAt: 1 });
      expect(hasPendingCanonicalSessionValidation(openOpenClawAgentDatabase(scope))).toBe(false);
    });
  },
);

it("certifies fresh keys and metadata without recompiling warm writer certification", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = { agentId: "main", env };
    const replace = (id: string, updatedAt: number) =>
      replaceSessionEntrySync(
        { ...scope, sessionKey: `agent:main:${id}` },
        { sessionId: id, updatedAt, label: `${id}-${updatedAt}` },
      );
    replace("first", 1);
    replace("second", 1);
    const database = openOpenClawAgentDatabase(scope);
    const compile = vi.spyOn(getSessionKysely(database.db).getExecutor(), "compileQuery");
    let certificationCompiles: string[];
    try {
      replace("second", 2);
      replace("first", 3);
      certificationCompiles = compile.mock.results.flatMap((result) =>
        result.type === "return" &&
        (result.value.sql.includes('"session_canonical_validation_pending"') ||
          result.value.sql.includes('"retained_window"'))
          ? [result.value.sql]
          : [],
      );
    } finally {
      compile.mockRestore();
    }
    expect(loadSessionEntry({ ...scope, sessionKey: "agent:main:first" })).toMatchObject({
      sessionId: "first",
      updatedAt: 3,
      label: "first-3",
    });
    expect(loadSessionEntry({ ...scope, sessionKey: "agent:main:second" })).toMatchObject({
      sessionId: "second",
      updatedAt: 2,
      label: "second-2",
    });
    expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
    expect(certificationCompiles).toEqual([]);
  });
});
