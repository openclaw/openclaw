import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasOpenClawAgentCanonicalValidation,
  invalidateOpenClawAgentDatabaseValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import { certifySessionCanonicalValidationPending } from "./session-canonical-validation-readiness.js";
import { hasPendingCanonicalSessionValidation } from "./session-canonical-validation.js";

afterEach(() => vi.restoreAllMocks());

function seedPendingRows(count: number, textBytes = 0) {
  const options = { agentId: "main" };
  const database = openOpenClawAgentDatabase(options);
  const insert = database.db.prepare(`
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at)
    VALUES (?, ?, ?, 1, 1)
  `);
  database.db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < count; index++) {
      const sessionId = `pending-${index}`;
      insert.run(
        `agent:main:${sessionId}`,
        sessionId,
        JSON.stringify({ sessionId, updatedAt: 1, lastRunError: "x".repeat(textBytes) }),
      );
    }
    database.db.exec("UPDATE session_nodes SET entry_valid = 1");
    database.db.exec("COMMIT");
  } catch (error) {
    database.db.exec("ROLLBACK");
    throw error;
  }
  return { options, database };
}

it("drains a large backlog in one retained worker while admitting foreground writes between batches", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { options, database } = seedPendingRows(260, 16 * 1024);
    const before = database.db
      .prepare("SELECT session_key, entry_json FROM session_nodes ORDER BY session_key")
      .all();
    const events: string[] = [];
    let foreground: Promise<void> | undefined;
    const createWorker = archiveWorker.createSqliteTranscriptArchiveWorker;
    const started = vi
      .spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker")
      .mockImplementation((data) => {
        const worker = createWorker(data);
        worker.on("message", (message: { type: string }) => {
          if (message.type !== "reclaimed") {
            return;
          }
          events.push("batch");
          foreground ??= runOpenClawAgentWriteAdmission(options, () => {
            events.push("foreground");
          });
        });
        return worker;
      });
    await certifySessionCanonicalValidationPending(options);
    await foreground;
    expect(started).toHaveBeenCalledOnce();
    expect(events[0]).toBe("batch");
    expect(events.indexOf("foreground")).toBeGreaterThan(0);
    expect(events.lastIndexOf("batch")).toBeGreaterThan(events.indexOf("foreground"));
    expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
    expect(
      database.db
        .prepare("SELECT session_key, entry_json FROM session_nodes ORDER BY session_key")
        .all(),
    ).toEqual(before);
  });
});

it("retains a changed row's marker instead of certifying its stale worker snapshot", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { options, database } = seedPendingRows(1);
    let changed = false;
    let markerRetainedAfterFirstBatch = false;
    const createWorker = archiveWorker.createSqliteTranscriptArchiveWorker;
    vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
      const worker = createWorker(data);
      worker.on("message", (message: { type: string }) => {
        if (message.type === "admission-request" && !changed) {
          changed = true;
          database.db.exec("UPDATE session_nodes SET parent_session_key = 'agent:main:changed'");
        } else if (message.type === "reclaimed") {
          markerRetainedAfterFirstBatch = hasPendingCanonicalSessionValidation(database);
        }
      });
      return worker;
    });
    await expect(certifySessionCanonicalValidationPending(options)).rejects.toThrow(
      "invalid persisted session row",
    );
    expect(changed).toBe(true);
    expect(markerRetainedAfterFirstBatch).toBe(true);
    expect(hasPendingCanonicalSessionValidation(database)).toBe(true);
    expect(database.db.prepare("SELECT parent_session_key FROM session_nodes").get()).toEqual({
      parent_session_key: "agent:main:changed",
    });
  });
});

it.each([false, true])(
  "fully validates a copied populated store whose pending table is clean (invalid row: %s)",
  async (invalid) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { options, database } = seedPendingRows(130);
      await certifySessionCanonicalValidationPending(options);
      const copiedPath = state.statePath("copied-agent.sqlite");
      database.db.prepare("VACUUM INTO ?").run(copiedPath);
      if (invalid) {
        const imported = new DatabaseSync(copiedPath);
        try {
          // Untrusted copied derived state cannot certify its own source contents.
          imported.exec(
            "UPDATE session_nodes SET parent_session_key = 'agent:main:changed' WHERE session_key = 'agent:main:pending-0'",
          );
          imported.exec("DELETE FROM session_canonical_validation_pending");
        } finally {
          imported.close();
        }
      }
      const copiedOptions = { ...options, path: copiedPath };
      const copied = openOpenClawAgentDatabase(copiedOptions);
      expect(hasPendingCanonicalSessionValidation(copied)).toBe(false);
      expect(hasOpenClawAgentCanonicalValidation(copied)).toBe(false);
      const result = certifySessionCanonicalValidationPending(copiedOptions);
      if (invalid) {
        await expect(result).rejects.toThrow("invalid persisted session row");
        expect(hasOpenClawAgentCanonicalValidation(copied)).toBe(false);
        expect(hasPendingCanonicalSessionValidation(copied)).toBe(true);
      } else {
        await result;
        expect(hasOpenClawAgentCanonicalValidation(copied)).toBe(true);
        expect(hasPendingCanonicalSessionValidation(copied)).toBe(false);
      }
    });
  },
);

it("refuses to publish canonical readiness after its physical verification receipt is revoked", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { options, database } = seedPendingRows(1);
    const createWorker = archiveWorker.createSqliteTranscriptArchiveWorker;
    vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
      const worker = createWorker(data);
      worker.on("message", (message: { type: string }) => {
        if (message.type === "reclaimed") {
          invalidateOpenClawAgentDatabaseValidation(database.path);
        }
      });
      return worker;
    });
    await expect(certifySessionCanonicalValidationPending(options)).rejects.toThrow(
      "database owner is no longer current",
    );
    expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
  });
});

it("retains pending validation when startup authority is revoked before worker write admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { options, database } = seedPendingRows(1);
    invalidateOpenClawAgentDatabaseValidation(database.path);
    expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
    let revoked = false;
    const createWorker = archiveWorker.createSqliteTranscriptArchiveWorker;
    vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
      const worker = createWorker(data);
      worker.on("message", (message: { type: string }) => {
        if (message.type === "admission-request") {
          revoked = true;
        }
      });
      return worker;
    });
    await expect(
      certifySessionCanonicalValidationPending(options, undefined, () => {
        if (revoked) {
          throw new Error("startup preparation was superseded");
        }
      }),
    ).rejects.toThrow("startup preparation was superseded");
    expect(revoked).toBe(true);
    expect(hasPendingCanonicalSessionValidation(database)).toBe(true);
    expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
  });
});

// Regression coverage for RIC-993 / RIC-996: the drain loop must converge even when
// active sessions keep changing canonical fields (entry_json / current_session_id)
// between the read snapshot and the write-time certify. The historical bug left
// certifiedRows=0 with hasMore=true forever, so the request path re-entered a
// non-converging 250ms-backoff drain on every call and pinned a Worker at 100%+ CPU.
describe("canonical validation drain convergence under active writes", () => {
  it("terminates after bounded stall rounds and marks canonicalReady while retaining pending", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { options, database } = seedPendingRows(1);
      // Mutate a canonical field on every batch's "reclaimed" event so the two-phase
      // read→certify snapshot always mismatches: sameCanonicalRow fails → certifiedRows=0
      // while hasMore stays true. This is the exact storm condition.
      let mutations = 0;
      let batches = 0;
      const createWorker = archiveWorker.createSqliteTranscriptArchiveWorker;
      vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
        const worker = createWorker(data);
        worker.on("message", (message: { type: string }) => {
          if (message.type === "reclaimed") {
            batches += 1;
            // Keep mutating entry_json (a canonical field) so the next snapshot differs.
            mutations += 1;
            database.db
              .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
              .run(
                JSON.stringify({ sessionId: "pending-0", updatedAt: mutations }),
                "agent:main:pending-0",
              );
          }
        });
        return worker;
      });
      const started = Date.now();
      await certifySessionCanonicalValidationPending(options);
      const elapsed = Date.now() - started;
      // The drain MUST exit (not loop forever). It should terminate within bounded
      // stall rounds, well under the old infinite 250ms-spin horizon.
      expect(elapsed).toBeLessThan(10_000);
      // canonicalReady is marked so request paths stop re-entering the drain.
      expect(hasOpenClawAgentCanonicalValidation(database)).toBe(true);
      // The row stayed pending because it never stopped changing; that is the correct,
      // consistency-preserving outcome — pending semantics are unchanged.
      expect(hasPendingCanonicalSessionValidation(database)).toBe(true);
      // Bounded stall: the loop did not spin unbounded batches.
      expect(batches).toBeLessThanOrEqual(8);
    });
  });

  it("does not re-mark already-certified rows when the contract trigger fires for an unchanged main_key", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { options, database } = seedPendingRows(3);
      // Drain everything first so pending is empty and canonicalReady is set.
      await certifySessionCanonicalValidationPending(options);
      expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
      expect(hasOpenClawAgentCanonicalValidation(database)).toBe(true);
      // A session_key_contract UPDATE that keeps main_key the same (no-op) must not
      // re-mark any session_nodes row pending: the after_update OF main_key trigger
      // fires only when OLD.main_key IS NOT NEW.main_key.
      database.db.exec("UPDATE session_key_contract SET main_key = main_key");
      expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
      // A genuine main_key change DOES re-mark rows (canonical validity is bound to main_key).
      database.db.exec("UPDATE session_key_contract SET main_key = 'rewritten-main-key'");
      expect(hasPendingCanonicalSessionValidation(database)).toBe(true);
    });
  });

  it("certifiedRows=0 with hasMore terminates instead of backing off forever", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      // Seed enough rows to keep hasMore=true across a batch while every row mismatches.
      const { options, database } = seedPendingRows(2);
      let batches = 0;
      const createWorker = archiveWorker.createSqliteTranscriptArchiveWorker;
      vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
        const worker = createWorker(data);
        worker.on("message", (message: { type: string }) => {
          if (message.type === "reclaimed") {
            batches += 1;
            // Migrate both rows' session_key lineage so snapshots always mismatch.
            database.db.exec(
              "UPDATE session_nodes SET parent_session_key = 'agent:main:stall-' || abs(random())",
            );
          }
        });
        return worker;
      });
      const started = Date.now();
      await certifySessionCanonicalValidationPending(options);
      const elapsed = Date.now() - started;
      // Must return, not hang.
      expect(elapsed).toBeLessThan(10_000);
      // canonicalReady set despite unconverged pending.
      expect(hasOpenClawAgentCanonicalValidation(database)).toBe(true);
      expect(hasPendingCanonicalSessionValidation(database)).toBe(true);
      // Bounded: MAX_STALL_BATCHES (4) plus the initializing batch.
      expect(batches).toBeLessThanOrEqual(8);
    });
  });
});
