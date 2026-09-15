import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import { openOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly-open.js";
import {
  adoptOpenClawAgentDatabaseValidation,
  getOpenClawAgentDatabaseValidation,
  hasOpenClawAgentCanonicalValidation,
  invalidateOpenClawAgentDatabaseValidation,
  markOpenClawAgentCanonicalValidation,
  setOpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";

async function withReceiptFixture(
  populated: boolean,
  run: (
    database: OpenClawAgentDatabase,
    options: OpenClawAgentDatabaseOptions,
  ) => void | Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    let database = openOpenClawAgentDatabase(options);
    if (populated) {
      database.db.exec(`INSERT INTO session_nodes
        (session_key, current_session_id, entry_json, updated_at)
        VALUES ('agent:main:existing', 'existing', '{"sessionId":"existing","updatedAt":1}', 1);
        UPDATE session_nodes SET entry_valid = 1;
        DELETE FROM session_canonical_validation_pending;`);
      invalidateOpenClawAgentDatabaseValidation(database.path);
      closeOpenClawAgentDatabaseByPath(database.path);
      database = openOpenClawAgentDatabase(options);
    }
    await run(database, options);
  });
}

describe("canonical proof on physical database validation", () => {
  it.each([false, true])(
    "initializes readiness from committed emptiness (populated: %s)",
    async (populated) => {
      await withReceiptFixture(populated, (database) => {
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(!populated);
      });
    },
  );

  it("keeps an empty database with pending work unready", async () => {
    await withReceiptFixture(false, (database) => {
      database.db
        .prepare("INSERT INTO session_canonical_validation_pending (session_key) VALUES (?)")
        .run("agent:main:unresolved");
      setOpenClawAgentDatabaseValidation(database);
      expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
    });
  });

  it("does not certify an uncommitted empty view that rolls back", async () => {
    await withReceiptFixture(true, (database, options) => {
      expect(() =>
        runOpenClawAgentWriteTransaction((current) => {
          current.db.exec("DELETE FROM session_nodes");
          setOpenClawAgentDatabaseValidation(current);
          expect(hasOpenClawAgentCanonicalValidation(current)).toBe(false);
          throw new Error("rollback empty view");
        }, options),
      ).toThrow("rollback empty view");
      expect(
        database.db.prepare("SELECT current_session_id FROM session_nodes").get()
          ?.current_session_id,
      ).toBe("existing");
      expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
    });
  });

  it("shares successful proof with registered thin readers but never raw readers", async () => {
    await withReceiptFixture(true, (database, options) => {
      const raw = new DatabaseSync(database.path, { readOnly: true });
      try {
        expect(hasOpenClawAgentCanonicalValidation({ agentId: "main", db: raw })).toBe(false);
        expect(markOpenClawAgentCanonicalValidation({ agentId: "main", db: raw })).toBe(false);
        const opened = openOpenClawAgentDatabaseReadOnly(options);
        if (!opened.found) {
          throw new Error("Expected readonly fixture database");
        }
        try {
          expect(
            markOpenClawAgentCanonicalValidation({ agentId: "main", db: opened.database.db }),
          ).toBe(true);
          expect(hasOpenClawAgentCanonicalValidation(database)).toBe(true);
          expect(
            hasOpenClawAgentCanonicalValidation({ agentId: "other", db: opened.database.db }),
          ).toBe(false);
        } finally {
          opened.database.close();
        }
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(true);
        expect(hasOpenClawAgentCanonicalValidation({ agentId: "main", db: raw })).toBe(false);
      } finally {
        raw.close();
      }
    });
  });

  it("publishes nested successful proof only after the outer commit", async () => {
    await withReceiptFixture(true, (database, options) => {
      runOpenClawAgentWriteTransaction(() => {
        runOpenClawAgentWriteTransaction((current) => {
          expect(markOpenClawAgentCanonicalValidation(current)).toBe(true);
          expect(hasOpenClawAgentCanonicalValidation(current)).toBe(false);
        }, options);
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
      }, options);
      expect(hasOpenClawAgentCanonicalValidation(database)).toBe(true);
    });
  });

  it.each(["outer", "savepoint"] as const)("discards proof after %s rollback", async (rollback) => {
    await withReceiptFixture(true, (database, options) => {
      const failing = () =>
        runOpenClawAgentWriteTransaction((current) => {
          expect(markOpenClawAgentCanonicalValidation(current)).toBe(true);
          throw new Error("rollback proof");
        }, options);
      if (rollback === "outer") {
        expect(failing).toThrow("rollback proof");
      } else {
        runOpenClawAgentWriteTransaction(() => {
          expect(failing).toThrow("rollback proof");
        }, options);
      }
      expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
    });
  });

  it("leaves manual transactions unready without an owned publication queue", async () => {
    await withReceiptFixture(true, (database) => {
      database.db.exec("BEGIN IMMEDIATE");
      expect(markOpenClawAgentCanonicalValidation(database)).toBe(false);
      database.db.exec("COMMIT");
      expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
    });
  });

  it("does not revive a receipt revoked before its commit callback", async () => {
    await withReceiptFixture(true, (database, options) => {
      runOpenClawAgentWriteTransaction((current) => {
        expect(markOpenClawAgentCanonicalValidation(current)).toBe(true);
        invalidateOpenClawAgentDatabaseValidation(current.path);
        setOpenClawAgentDatabaseValidation(current);
      }, options);
      expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
    });
  });

  it.each(["native close", "native dispose", "owner close"] as const)(
    "retains proof across %s and reopen",
    async (action) => {
      await withReceiptFixture(true, (database, options) => {
        expect(markOpenClawAgentCanonicalValidation(database)).toBe(true);
        const receipt = getOpenClawAgentDatabaseValidation(database);
        if (action === "native close") {
          database.db.close();
        } else if (action === "native dispose") {
          database.db[Symbol.dispose]();
        } else {
          closeOpenClawAgentDatabaseByPath(database.path);
        }
        const reopened = openOpenClawAgentDatabase(options);
        expect(getOpenClawAgentDatabaseValidation(reopened) === receipt).toBe(true);
        expect(hasOpenClawAgentCanonicalValidation(reopened)).toBe(true);
      });
    },
  );

  it("shares readiness through worker receipt transfer and rejects revoked transfers", async () => {
    await withReceiptFixture(true, (database, options) => {
      const receipt = getOpenClawAgentDatabaseValidation(database);
      if (!receipt) {
        throw new Error("Expected physical validation receipt");
      }
      const transferred = structuredClone(receipt);
      const opened = openOpenClawAgentDatabaseReadOnly(options);
      if (!opened.found) {
        throw new Error("Expected readonly fixture database");
      }
      try {
        expect(adoptOpenClawAgentDatabaseValidation(opened.database, transferred)).toBe(true);
        expect(markOpenClawAgentCanonicalValidation(opened.database)).toBe(true);
        expect(Atomics.load(new Int32Array(transferred.canonicalReady), 0)).toBe(1);
        invalidateOpenClawAgentDatabaseValidation(database.path);
        expect(adoptOpenClawAgentDatabaseValidation(opened.database, transferred)).toBe(false);
        expect(hasOpenClawAgentCanonicalValidation(opened.database)).toBe(false);
      } finally {
        opened.database.close();
      }
    });
  });

  it.runIf(typeof DatabaseSync.prototype.deserialize === "function")(
    "revokes proof on a failed native replacement attempt",
    async () => {
      await withReceiptFixture(true, (database) => {
        expect(markOpenClawAgentCanonicalValidation(database)).toBe(true);
        const serialized = database.db.serialize();
        database.db.exec("BEGIN IMMEDIATE");
        try {
          database.db.prepare("SELECT session_key FROM session_nodes").get();
          expect(() => database.db.deserialize(serialized)).toThrow();
          expect(getOpenClawAgentDatabaseValidation(database)).toBeUndefined();
          expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
        } finally {
          database.db.exec("ROLLBACK");
        }
      });
    },
  );
});
