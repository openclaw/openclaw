import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { recordOpenClawAgentCanonicalValidation } from "./openclaw-agent-canonical-validation-receipt.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import { openOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly-open.js";
import {
  adoptOpenClawAgentDatabaseValidation,
  captureOpenClawAgentDatabaseValidationTransfer,
  clearOpenClawAgentDatabaseValidationCache,
  getOpenClawAgentDatabaseValidation,
  getOpenClawAgentDatabaseValidationForTransfer,
  hasOpenClawAgentCanonicalValidation,
  invalidateOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidationsForAgent,
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
  it("does not publish an uncommitted durable receipt into a cold reader cache", async () => {
    await withReceiptFixture(true, (database, options) => {
      expect(() =>
        runOpenClawAgentWriteTransaction((current) => {
          recordOpenClawAgentCanonicalValidation(current);
          clearOpenClawAgentDatabaseValidationCache(current.path);
          expect(hasOpenClawAgentCanonicalValidation(current)).toBe(false);
          throw new Error("rollback durable receipt");
        }, options),
      ).toThrow("rollback durable receipt");
      expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
      expect(database.db.prepare("SELECT canonical_ready FROM session_key_contract").get()).toEqual(
        { canonical_ready: null },
      );
    });
  });

  function independentWorkerReceipt(database: OpenClawAgentDatabase) {
    const receipt = getOpenClawAgentDatabaseValidation(database);
    if (!receipt) {
      throw new Error("Expected physical validation receipt");
    }
    // A native first opener can establish proof before the host has any receipt.
    return {
      ...receipt,
      valid: receipt.valid.slice(0),
      canonicalReady: receipt.canonicalReady.slice(0),
    };
  }

  describe("native integrity proof handoff", () => {
    it("accepts proof without a host handle and shares subsequent host revocation", async () => {
      await withReceiptFixture(false, (database) => {
        const received = independentWorkerReceipt(database);
        closeOpenClawAgentDatabaseByPath(database.path);
        clearOpenClawAgentDatabaseValidationCache(database.path);
        const adopt = captureOpenClawAgentDatabaseValidationTransfer(database);

        expect(adopt(received.identity, received)).toBe(true);
        expect(getOpenClawAgentDatabaseValidationForTransfer(database)?.valid).toBe(received.valid);
        invalidateOpenClawAgentDatabaseValidation(database.path);
        expect(Atomics.load(new Int32Array(received.valid), 0)).toBe(0);
        expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
      });
    });

    it("does not restore delayed proof after path, repeated, cache, or agent revocation", async () => {
      await withReceiptFixture(false, (database) => {
        const received = independentWorkerReceipt(database);
        clearOpenClawAgentDatabaseValidationCache(database.path);

        const beforeInvalidation = captureOpenClawAgentDatabaseValidationTransfer(database);
        invalidateOpenClawAgentDatabaseValidation(database.path);
        expect(beforeInvalidation(received.identity, received)).toBe(false);

        const beforeRepeatedInvalidation = captureOpenClawAgentDatabaseValidationTransfer(database);
        invalidateOpenClawAgentDatabaseValidation(database.path);
        expect(beforeRepeatedInvalidation(received.identity, received)).toBe(false);

        const beforeClear = captureOpenClawAgentDatabaseValidationTransfer(database);
        clearOpenClawAgentDatabaseValidationCache(database.path);
        expect(beforeClear(received.identity, received)).toBe(false);

        // A path can be revoked before its first native opener associates an agent.
        invalidateOpenClawAgentDatabaseValidation(database.path);
        const beforeAgentInvalidation = captureOpenClawAgentDatabaseValidationTransfer(database);
        invalidateOpenClawAgentDatabaseValidationsForAgent(database.agentId, []);
        expect(beforeAgentInvalidation(received.identity, received)).toBe(false);
        expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
        expect(Atomics.load(new Int32Array(received.valid), 0)).toBe(1);

        const afterInvalidation = captureOpenClawAgentDatabaseValidationTransfer(database);
        expect(afterInvalidation(received.identity, received)).toBe(true);
        expect(getOpenClawAgentDatabaseValidationForTransfer(database)?.valid).toBe(received.valid);
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);

        invalidateOpenClawAgentDatabaseValidation(database.path);
        const successor = { path: database.path, agentId: "successor" };
        const beforeOwnerRevocation = captureOpenClawAgentDatabaseValidationTransfer(successor);
        invalidateOpenClawAgentDatabaseValidationsForAgent(successor.agentId, []);
        const successorReceipt = {
          ...received,
          agentId: successor.agentId,
          identity: "successor-file",
          valid: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
        };
        Atomics.store(new Int32Array(successorReceipt.valid), 0, 1);
        expect(beforeOwnerRevocation(successorReceipt.identity, successorReceipt)).toBe(false);
      });
    });

    it("rejects delayed proof when a peer revokes the captured shared receipt", async () => {
      await withReceiptFixture(false, (database) => {
        const received = independentWorkerReceipt(database);
        const original = getOpenClawAgentDatabaseValidation(database)!;
        const peer = structuredClone(original);
        const adopt = captureOpenClawAgentDatabaseValidationTransfer(database);

        Atomics.store(new Int32Array(peer.valid), 0, 0);

        expect(Atomics.load(new Int32Array(original.valid), 0)).toBe(0);
        expect(Atomics.load(new Int32Array(received.valid), 0)).toBe(1);
        expect(adopt(received.identity, received)).toBe(false);
        expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
      });
    });

    it("rejects foreign, revoked, and malformed receipts without accepting their proof", async () => {
      await withReceiptFixture(false, (database) => {
        const received = independentWorkerReceipt(database);
        clearOpenClawAgentDatabaseValidationCache(database.path);
        const adopt = captureOpenClawAgentDatabaseValidationTransfer(database);
        for (const invalid of [
          { ...received, agentId: "another-agent" },
          { ...received, identity: "another-file" },
          { ...received, valid: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT) },
          { ...received, valid: new SharedArrayBuffer(1) },
          { ...received, valid: new ArrayBuffer(Int32Array.BYTES_PER_ELEMENT) },
          { ...received, canonicalReady: new SharedArrayBuffer(1) },
        ]) {
          expect(adopt(received.identity, invalid)).toBe(false);
          expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
        }
        expect(adopt(received.identity, received)).toBe(true);
        expect(getOpenClawAgentDatabaseValidationForTransfer(database)?.valid).toBe(received.valid);
      });
    });

    it("keeps durable canonical proof readable during a pending native handoff", async () => {
      await withReceiptFixture(false, (database, options) => {
        runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
        clearOpenClawAgentDatabaseValidationCache(database.path);
        captureOpenClawAgentDatabaseValidationTransfer(database);

        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(true);
        expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
      });
    });
  });

  it.each([
    { cache: "warm", admission: "set" },
    { cache: "cold", admission: "set" },
    { cache: "warm", admission: "adopt" },
    { cache: "cold", admission: "adopt" },
  ] as const)(
    "does not revive revoked canonical proof on $cache integrity admission by $admission",
    async ({ cache, admission }) => {
      await withReceiptFixture(true, (database, options) => {
        runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
        expect(markOpenClawAgentCanonicalValidation(database)).toBe(true);
        const receipt = getOpenClawAgentDatabaseValidation(database);
        if (!receipt) {
          throw new Error("Expected physical validation receipt");
        }
        // A separate worker can retain independent proof for this same physical file.
        const transferred = {
          ...receipt,
          valid: receipt.valid.slice(0),
          canonicalReady: receipt.canonicalReady.slice(0),
        };
        if (cache === "cold") {
          clearOpenClawAgentDatabaseValidationCache(database.path);
        }
        invalidateOpenClawAgentDatabaseValidation(database.path);
        if (admission === "adopt") {
          expect(adoptOpenClawAgentDatabaseValidation(database, transferred)).toBe(true);
          expect(getOpenClawAgentDatabaseValidation(database)).toBe(transferred);
        } else {
          setOpenClawAgentDatabaseValidation(database);
          expect(getOpenClawAgentDatabaseValidation(database)).toBeDefined();
        }
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
        expect(markOpenClawAgentCanonicalValidation(database)).toBe(true);
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(true);
        if (admission === "adopt") {
          expect(Atomics.load(new Int32Array(transferred.canonicalReady), 0)).toBe(1);
        }
      });
    },
  );

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
