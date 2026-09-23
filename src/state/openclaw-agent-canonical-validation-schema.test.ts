import assert from "node:assert/strict";
import { constants, DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  assertCanonicalSessionValidationSchema,
  withoutCanonicalSessionValidationSchema,
} from "./openclaw-agent-canonical-validation-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_V21_SQL } from "./openclaw-agent-schema-v21.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

const key = "agent:main:target";
const sibling = "agent:main:sibling";

function pendingKeys(database: DatabaseSync) {
  return database
    .prepare("SELECT session_key FROM session_canonical_validation_pending ORDER BY session_key")
    .all()
    .map((row) => row.session_key);
}

function insertNode(database: DatabaseSync, sessionKey: string, sessionId: string) {
  database
    .prepare(`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES (?, ?, ?, 1)`)
    .run(sessionKey, sessionId, JSON.stringify({ sessionId, updatedAt: 1 }));
  database
    .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
    .run(sessionKey);
}

function insertWindow(database: DatabaseSync, sessionKey: string, sessionId: string) {
  database
    .prepare(`INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
      VALUES (?, ?, 1, 1)`)
    .run(sessionId, sessionKey);
}

function clearPending(database: DatabaseSync) {
  database.exec("DELETE FROM session_canonical_validation_pending");
}

function withDatabase(run: (database: DatabaseSync) => void) {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(OPENCLAW_AGENT_SCHEMA_SQL);
    run(database);
  } finally {
    if (database.isOpen) {
      database.close();
    }
  }
}

describe("canonical session validation invalidation", () => {
  it.each([
    ["entry_json", '{"sessionId":"target","updatedAt":2}'],
    ["current_session_id", "replacement"],
    ["entry_valid", 0],
    ["parent_session_key", "agent:main:parent"],
    ["spawned_by", "agent:main:spawner"],
    ["fork_source_session_key", "agent:main:fork"],
    ["updated_at", 2],
  ] as const)("records a raw %s edit without invalidating a sibling", (column, value) => {
    withDatabase((database) => {
      insertNode(database, key, "target");
      insertNode(database, sibling, "sibling");
      clearPending(database);
      database
        .prepare(`UPDATE session_nodes SET ${column} = ? WHERE session_key = ?`)
        .run(value, key);
      expect(pendingKeys(database)).toEqual([key]);
      // An older writer can settle its validity flag, but cannot certify the newer contract.
      database.prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?").run(key);
      expect(pendingKeys(database)).toEqual([key]);
    });
  });

  it("records insertion and replaces a renamed marker without requiring foreign keys", () => {
    withDatabase((database) => {
      database.exec("PRAGMA foreign_keys = OFF");
      insertNode(database, key, "target");
      expect(pendingKeys(database)).toEqual([key]);
      database
        .prepare("UPDATE session_nodes SET session_key = ? WHERE session_key = ?")
        .run(sibling, key);
      expect(pendingKeys(database)).toEqual([sibling]);
      database.prepare("DELETE FROM session_nodes WHERE session_key = ?").run(sibling);
      expect(pendingKeys(database)).toEqual([]);
    });
  });

  it("preserves pending work under outer REPLACE and IGNORE conflict policies", () => {
    withDatabase((database) => {
      insertNode(database, key, "target");
      insertNode(database, sibling, "sibling");
      database
        .prepare("UPDATE OR REPLACE session_nodes SET session_key = ? WHERE session_key = ?")
        .run(sibling, key);
      expect(pendingKeys(database)).toEqual([sibling]);
      database
        .prepare("UPDATE OR IGNORE session_nodes SET spawned_by = ? WHERE session_key = ?")
        .run(key, sibling);
      expect(pendingKeys(database)).toEqual([sibling]);
      database
        .prepare(`INSERT OR REPLACE INTO session_nodes
        (session_key, current_session_id, entry_json, updated_at) VALUES (?, 'again', '{}', 2)`)
        .run(sibling);
      expect(pendingKeys(database)).toEqual([sibling]);
    });
  });

  it("invalidates both old and new retained-window associations", () => {
    withDatabase((database) => {
      insertNode(database, key, "old-window");
      insertNode(database, sibling, "new-window");
      clearPending(database);
      insertWindow(database, key, "old-window");
      expect(pendingKeys(database)).toEqual([key]);
      clearPending(database);
      database
        .prepare("UPDATE session_windows SET session_id = ?, session_key = ? WHERE session_id = ?")
        .run("new-window", sibling, "old-window");
      expect(pendingKeys(database)).toEqual([sibling, key].toSorted());
      clearPending(database);
      database
        .prepare("UPDATE session_windows SET session_key = ? WHERE session_id = ?")
        .run(key, "new-window");
      expect(pendingKeys(database)).toEqual([sibling]);
      clearPending(database);
      database.prepare("DELETE FROM session_windows WHERE session_id = ?").run("new-window");
      expect(pendingKeys(database)).toEqual([sibling]);
    });
  });

  it("does not dirty unrelated windows or unchanged lineage and policy values", () => {
    withDatabase((database) => {
      insertNode(database, key, "target");
      insertWindow(database, key, "target");
      clearPending(database);
      database.exec(`
        UPDATE session_nodes SET parent_session_key = parent_session_key, label = 'new label';
        UPDATE session_windows SET session_key = session_key, updated_at = 2;
        UPDATE session_key_contract SET main_key = main_key, updated_at = 2;
      `);
      insertWindow(database, key, "historical-window");
      database.prepare("DELETE FROM session_windows WHERE session_id = ?").run("historical-window");
      expect(pendingKeys(database)).toEqual([]);
    });
  });

  it.each(["insert", "update", "delete"] as const)(
    "invalidates every node on policy %s",
    (action) => {
      withDatabase((database) => {
        insertNode(database, key, "target");
        insertNode(database, sibling, "sibling");
        if (action === "insert") {
          database.exec("DELETE FROM session_key_contract");
        }
        clearPending(database);
        if (action === "insert") {
          database.exec(
            "INSERT INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'work', 2)",
          );
        } else if (action === "update") {
          database.exec("UPDATE session_key_contract SET main_key = 'work'");
        } else {
          database.exec("DELETE FROM session_key_contract");
        }
        expect(pendingKeys(database)).toEqual([key, sibling].toSorted());
      });
    },
  );

  it("rolls back invalidation and marker removal with their data changes", () => {
    withDatabase((database) => {
      insertNode(database, key, "target");
      clearPending(database);
      database.exec("BEGIN IMMEDIATE");
      database
        .prepare("UPDATE session_nodes SET spawned_by = ? WHERE session_key = ?")
        .run(sibling, key);
      expect(pendingKeys(database)).toEqual([key]);
      database.exec("ROLLBACK");
      expect(pendingKeys(database)).toEqual([]);
      database
        .prepare("UPDATE session_nodes SET spawned_by = ? WHERE session_key = ?")
        .run(sibling, key);
      database.exec("BEGIN IMMEDIATE");
      clearPending(database);
      database.exec("ROLLBACK");
      expect(pendingKeys(database)).toEqual([key]);
    });
  });
});

describe("canonical validation schema admission", () => {
  const missingTable = expect.objectContaining({
    name: "SessionMetadataUnavailableError",
    reason: "table-missing",
    missingTables: ["session_canonical_validation_pending"],
    cause: expect.objectContaining({ message: expect.stringMatching(/missing or drifted/u) }),
  });
  it.each([
    "DROP TABLE session_canonical_validation_pending",
    "DROP TRIGGER session_nodes_canonical_pending_after_update",
    "DROP TRIGGER session_windows_canonical_pending_after_delete",
    "DROP TRIGGER session_key_contract_canonical_pending_after_update",
    `CREATE TRIGGER clear_canonical_pending AFTER INSERT ON session_canonical_validation_pending
      BEGIN DELETE FROM session_canonical_validation_pending; END`,
  ])("rejects changed required schema after a cached admission (%#)", (change) => {
    withDatabase((database) => {
      assertCanonicalSessionValidationSchema(database);
      database.exec(change);
      expect(() => assertCanonicalSessionValidationSchema(database)).toThrow(
        change.startsWith("DROP TABLE")
          ? missingTable
          : /canonical validation schema is missing or drifted/u,
      );
    });
  });

  it("does not reuse validation performed inside a rolled-back schema transaction", () => {
    withDatabase((database) => {
      database.exec("BEGIN; CREATE TABLE temporary_shape (id INTEGER)");
      assertCanonicalSessionValidationSchema(database);
      database.exec("ROLLBACK; DROP TRIGGER session_nodes_canonical_pending_after_delete");
      expect(() => assertCanonicalSessionValidationSchema(database)).toThrow(/missing or drifted/u);
    });
  });

  it.each(["close", "dispose"] as const)(
    "invalidates native %s before the same object reopens",
    (action) => {
      withDatabase((database) => {
        assertCanonicalSessionValidationSchema(database);
        const cookie = database.prepare("PRAGMA schema_version").get()?.schema_version;
        assert(typeof cookie === "number");
        if (action === "close") {
          database.close();
        } else {
          database[Symbol.dispose]();
        }
        database.open();
        database.exec(withoutCanonicalSessionValidationSchema(OPENCLAW_AGENT_SCHEMA_SQL));
        database.exec(`PRAGMA schema_version = ${cookie}`);
        expect(() => assertCanonicalSessionValidationSchema(database)).toThrow(missingTable);
      });
    },
  );

  it.runIf(typeof DatabaseSync.prototype.deserialize === "function")(
    "invalidates deserialized schema even when the cookie is unchanged",
    () => {
      withDatabase((database) => {
        assertCanonicalSessionValidationSchema(database);
        const cookie = database.prepare("PRAGMA schema_version").get()?.schema_version;
        assert(typeof cookie === "number");
        const replacement = new DatabaseSync(":memory:");
        try {
          replacement.exec(withoutCanonicalSessionValidationSchema(OPENCLAW_AGENT_SCHEMA_SQL));
          replacement.exec(`PRAGMA schema_version = ${cookie}`);
          database.deserialize(replacement.serialize());
          expect(() => assertCanonicalSessionValidationSchema(database)).toThrow(missingTable);
        } finally {
          replacement.close();
        }
      });
    },
  );
});

describe("agent schema 21 migration", () => {
  it("seeds all rows without parsing their contents and keeps already-open writers observable", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("pre-validation.sqlite");
      const database = new DatabaseSync(pathname);
      let oldWriter: DatabaseSync | undefined;
      try {
        database.exec(withoutCanonicalSessionValidationSchema(OPENCLAW_AGENT_SCHEMA_V21_SQL));
        database.exec(`PRAGMA user_version = 20;
          INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
          VALUES ('primary', 'agent', 20, 'main', 1, 1)`);
        insertNode(database, key, "target");
        insertNode(database, sibling, "sibling");
        database
          .prepare("UPDATE session_nodes SET entry_json = '{' WHERE session_key = ?")
          .run(sibling);
        const before = database.prepare("SELECT * FROM session_nodes ORDER BY session_key").all();
        oldWriter = new DatabaseSync(pathname);
        const oldWrite = oldWriter.prepare(
          "UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?",
        );
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          ensureOpenClawAgentDatabaseSchema(database, {
            agentId: "main",
            env: state.env,
            path: pathname,
          });
        });
        expect(database.prepare("SELECT * FROM session_nodes ORDER BY session_key").all()).toEqual(
          before,
        );
        expect(pendingKeys(database)).toEqual([key, sibling].toSorted());
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        expect(
          database
            .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
            .get()?.schema_version,
        ).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
        assertCanonicalSessionValidationSchema(database);
        clearPending(database);
        oldWrite.run(sibling, key);
        expect(pendingKeys(database)).toEqual([key]);
      } finally {
        oldWriter?.close();
        database.close();
      }
    });
  });

  it("rolls back schema installation, pending seed and version publication together", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("interrupted-validation.sqlite");
      const database = new DatabaseSync(pathname);
      try {
        database.exec(withoutCanonicalSessionValidationSchema(OPENCLAW_AGENT_SCHEMA_V21_SQL));
        database.exec(`PRAGMA user_version = 20;
          INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
          VALUES ('primary', 'agent', 20, 'main', 1, 1)`);
        insertNode(database, key, "target");
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          database.setAuthorizer((action, name, value) =>
            action === constants.SQLITE_PRAGMA &&
            name === "user_version" &&
            value === String(OPENCLAW_AGENT_SCHEMA_VERSION)
              ? constants.SQLITE_DENY
              : constants.SQLITE_OK,
          );
          try {
            expect(() =>
              ensureOpenClawAgentDatabaseSchema(database, {
                agentId: "main",
                env: state.env,
                path: pathname,
              }),
            ).toThrow(/authoriz/u);
          } finally {
            database.setAuthorizer(null);
          }
          expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(20);
          expect(
            database
              .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
              .get()?.schema_version,
          ).toBe(20);
          expect(
            database
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name = 'session_canonical_validation_pending'",
              )
              .get(),
          ).toBeUndefined();
          ensureOpenClawAgentDatabaseSchema(database, {
            agentId: "main",
            env: state.env,
            path: pathname,
          });
          expect(pendingKeys(database)).toEqual([key]);
          assertCanonicalSessionValidationSchema(database);
        });
      } finally {
        database.close();
      }
    });
  });
});
