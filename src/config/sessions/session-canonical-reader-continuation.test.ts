import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { registerNodeSqliteDisposeCallback } from "../../infra/kysely-sync-cache-state.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { readExactSessionEntryRowValidated } from "./session-accessor.sqlite-entry-read.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  captureCanonicalSessionReaderContinuation,
  readWithCanonicalSessionAdmission,
  readWithCanonicalSessionReaderContinuation,
  setCanonicalSqliteSessionMainKey,
} from "./session-canonical-key.js";
import { seedCanonicalSessionValidation } from "./session-canonical-validation.js";

const healthy = "agent:main:healthy";
const damaged = "agent:main:damaged";
type FixtureDatabase = ReturnType<typeof openOpenClawAgentDatabase>;

function capture(database: FixtureDatabase) {
  const continuation = captureCanonicalSessionReaderContinuation(database);
  if (!continuation) {
    throw new Error("Expected an existing committed reader admission");
  }
  return continuation;
}

function corrupt(database: FixtureDatabase) {
  // Keep the held reader receipt while seeding the unvalidated-row fixture.
  runSqliteImmediateTransactionSync(database.db, () => seedCanonicalSessionValidation(database));
  database.db
    .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
    .run("{", damaged);
  database.db
    .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
    .run(damaged);
}

function replaceDatabasePath(pathname: string): () => void {
  const replacementPath = `${pathname}.continuation-new`;
  const displacedPath = `${pathname}.continuation-old`;
  const replacement = new DatabaseSync(replacementPath);
  try {
    replacement.exec("CREATE TABLE replacement_marker (value TEXT)");
  } finally {
    replacement.close();
  }
  fs.renameSync(pathname, displacedPath);
  try {
    fs.renameSync(replacementPath, pathname);
  } catch (error) {
    fs.renameSync(displacedPath, pathname);
    throw error;
  }
  return () => fs.renameSync(displacedPath, pathname);
}

async function withReaders(
  run: (fixture: {
    database: FixtureDatabase;
    reader: Extract<
      ReturnType<typeof openOpenClawAgentDatabaseReadOnly>,
      { found: true }
    >["database"];
    options: { agentId: string; env: NodeJS.ProcessEnv };
  }) => void,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    for (const sessionId of ["healthy", "damaged"]) {
      replaceSessionEntrySync(
        { ...options, sessionKey: `agent:main:${sessionId}` },
        { sessionId, updatedAt: 1 },
      );
    }
    const database = openOpenClawAgentDatabase(options);
    assertCanonicalSqliteSessionKeysCurrent(database);
    const opened = openOpenClawAgentDatabaseReadOnly(options);
    if (!opened.found) {
      throw new Error("Expected the seeded read-only database");
    }
    try {
      run({ database, reader: opened.database, options });
    } finally {
      opened.database.close();
    }
  });
}

it("continues admitted row parsing without admitting the pooled reader's next operation", async () => {
  await withReaders(({ database, reader }) => {
    const held = capture(database);
    const receipt = structuredClone(held.receipt);
    corrupt(database);
    try {
      expect(() =>
        readWithCanonicalSessionAdmission(reader, () =>
          readExactSessionEntryRowValidated(reader, healthy),
        ),
      ).toThrow("openclaw doctor --fix");
      readWithCanonicalSessionReaderContinuation(reader, receipt, () => {
        expect(reader.db.isTransaction).toBe(true);
        expect(readExactSessionEntryRowValidated(reader, healthy)?.entry.sessionId).toBe("healthy");
        expect(() => readExactSessionEntryRowValidated(reader, damaged)).toThrow(
          "openclaw doctor --fix",
        );
      });
      expect(() =>
        readWithCanonicalSessionReaderContinuation(reader, undefined, () =>
          readExactSessionEntryRowValidated(reader, healthy),
        ),
      ).toThrow("openclaw doctor --fix");
      expect(captureCanonicalSessionReaderContinuation(reader)).toBeUndefined();
    } finally {
      held.release();
    }
  });
});

it("captures and revalidates existing admission without host SQL", async () => {
  await withReaders(({ database, reader, options }) => {
    expect(captureCanonicalSessionReaderContinuation(reader)).toBeUndefined();
    runOpenClawAgentWriteTransaction(() => {
      expect(captureCanonicalSessionReaderContinuation(database)).toBeUndefined();
    }, options);
    const queries = trackSqliteStatementExecutions(database.db, ["host"], () => "host");
    const exec = vi.spyOn(database.db, "exec").mockImplementation(() => {
      throw new Error("host SQL");
    });
    try {
      const held = capture(database);
      held.assertCurrent();
      held.release();
      expect(() => held.assertCurrent()).toThrow("no longer current");
      expect(queries.counts.host).toBe(0);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      queries.restore();
      exec.mockRestore();
    }
  });
});

it.each([
  "release",
  "native close",
  "native dispose",
  "main key",
  "validation",
  "readiness",
  "admission replacement",
  "owner close",
  "active worker transaction",
])("requires strict fresh admission after %s", async (reason) => {
  await withReaders(({ database, reader }) => {
    const held = capture(database);
    const receipt = structuredClone(held.receipt);
    if (reason === "admission replacement") {
      setCanonicalSqliteSessionMainKey(database, "custom");
      assertCanonicalSqliteSessionKeysCurrent(database);
    }
    corrupt(database);
    const observations: Array<{ open: boolean; live: number }> = [];
    const stop =
      reason === "owner close"
        ? registerNodeSqliteDisposeCallback(database.db, () => {
            observations.push({
              open: database.db.isOpen,
              live: Atomics.load(new Int32Array(held.receipt.live), 0),
            });
          })
        : undefined;
    if (reason === "owner close") {
      closeOpenClawAgentDatabaseByPath(database.path);
      expect(observations).toContainEqual({ open: true, live: 0 });
    }
    if (reason === "active worker transaction") {
      reader.db.exec("BEGIN");
    }
    if (reason === "release") {
      held.release();
    }
    if (reason === "native close") {
      database.db.close();
    }
    if (reason === "native dispose") {
      database.db[Symbol.dispose]();
    }
    if (reason === "main key") {
      setCanonicalSqliteSessionMainKey(database, "custom");
    }
    if (reason === "validation") {
      invalidateOpenClawAgentDatabaseValidation(database.path);
    }
    if (reason === "readiness") {
      Atomics.store(new Int32Array(held.receipt.validation.canonicalReady), 0, 0);
    }
    try {
      if (reason !== "active worker transaction") {
        expect(() => held.assertCurrent()).toThrow("no longer current");
      }
      expect(() =>
        readWithCanonicalSessionReaderContinuation(reader, receipt, () =>
          readExactSessionEntryRowValidated(reader, healthy),
        ),
      ).toThrow("openclaw doctor --fix");
    } finally {
      if (reason === "active worker transaction") {
        reader.db.exec("ROLLBACK");
      }
      stop?.();
      held.release();
    }
  });
});

it.each(["release", "readiness", "post-commit release"])(
  "refuses publication when %s changes before publication",
  async (change) => {
    await withReaders(({ database, reader }) => {
      const held = capture(database);
      corrupt(database);
      try {
        expect(() =>
          readWithCanonicalSessionReaderContinuation(reader, structuredClone(held.receipt), () => {
            const result = readExactSessionEntryRowValidated(reader, healthy);
            if (change === "release") {
              held.release();
            } else if (change === "readiness") {
              Atomics.store(new Int32Array(held.receipt.validation.canonicalReady), 0, 0);
            } else {
              expect(deferSqlitePostCommitPublication(reader.db, held.release)).toBe(true);
            }
            return result;
          }),
        ).toThrow("no longer current");
      } finally {
        held.release();
      }
    });
  },
);

it("does not export a proof whose readiness changed at its admission commit", async () => {
  await withReaders(({ database, options }) => {
    const before = capture(database);
    Atomics.store(new Int32Array(before.receipt.validation.canonicalReady), 0, 0);
    runOpenClawAgentWriteTransaction((current) => {
      assertCanonicalSqliteSessionKeysCurrent(current);
    }, options);
    expect(Atomics.load(new Int32Array(before.receipt.validation.canonicalReady), 0)).toBe(1);
    expect(captureCanonicalSessionReaderContinuation(database)).toBeUndefined();
    assertCanonicalSqliteSessionKeysCurrent(database);
    capture(database).release();
    before.release();
  });
});

it("refuses a receipt for another physical database with the same agent owner", async () => {
  await withReaders(({ database, options }) => {
    const held = capture(database);
    const otherOptions = {
      ...options,
      path: path.join(path.dirname(database.path), "other.sqlite"),
    };
    runOpenClawAgentWriteTransaction((other) => {
      writeSessionEntry(other, healthy, { sessionId: "other-healthy", updatedAt: 1 });
      writeSessionEntry(other, damaged, { sessionId: "other-damaged", updatedAt: 1 });
    }, otherOptions);
    const other = openOpenClawAgentDatabase(otherOptions);
    corrupt(other);
    const opened = openOpenClawAgentDatabaseReadOnly(otherOptions);
    if (!opened.found) {
      throw new Error("Expected the second physical database");
    }
    try {
      expect(() =>
        readWithCanonicalSessionReaderContinuation(opened.database, held.receipt, () =>
          readExactSessionEntryRowValidated(opened.database, healthy),
        ),
      ).toThrow("openclaw doctor --fix");
    } finally {
      held.release();
      opened.database.close();
    }
  });
});

it.each([
  { ending: "rollback", admitted: false },
  { ending: "manual commit", admitted: false },
  { ending: "invalidate before commit", admitted: false },
  { ending: "rollback", admitted: true },
])(
  "retains only committed admission after $ending (previous admission: $admitted)",
  async ({ ending, admitted }) => {
    await withReaders(({ database, options }) => {
      const held = admitted ? capture(database) : undefined;
      if (!admitted) {
        closeOpenClawAgentDatabaseByPath(database.path);
      }
      const current = admitted ? database : openOpenClawAgentDatabase(options);
      if (!admitted) {
        expect(captureCanonicalSessionReaderContinuation(current)).toBeUndefined();
      }
      try {
        if (ending === "manual commit") {
          current.db.exec("BEGIN");
          try {
            assertCanonicalSqliteSessionKeysCurrent(current);
            expect(captureCanonicalSessionReaderContinuation(current)).toBeUndefined();
          } finally {
            current.db.exec("COMMIT");
          }
        } else {
          const failure = admitted ? "rollback policy" : "abandoned admission";
          const run = () =>
            runOpenClawAgentWriteTransaction((writer) => {
              if (admitted) {
                setCanonicalSqliteSessionMainKey(writer, "custom");
              }
              assertCanonicalSqliteSessionKeysCurrent(writer);
              expect(captureCanonicalSessionReaderContinuation(writer)).toBeUndefined();
              if (ending === "rollback") {
                throw new Error(failure);
              }
              setCanonicalSqliteSessionMainKey(writer, "custom");
            }, options);
          if (ending === "rollback") {
            expect(run).toThrow(failure);
          } else {
            run();
          }
        }
        if (held) {
          expect(() => held.assertCurrent()).toThrow("no longer current");
        }
        if (admitted && ending === "rollback") {
          assertCanonicalSqliteSessionKeysCurrent(current);
          const next = capture(current);
          next.assertCurrent();
          next.release();
        } else {
          expect(captureCanonicalSessionReaderContinuation(current)).toBeUndefined();
        }
      } finally {
        held?.release();
      }
    });
  },
);

// POSIX permits replacing a pathname while both native connections remain open.
it.runIf(process.platform !== "win32").each(["before host publication", "before worker return"])(
  "rejects physical replacement %s while the original handles remain open",
  async (when) => {
    await withReaders(({ database, reader }) => {
      const held = capture(database);
      let restore: (() => void) | undefined;
      corrupt(database);
      try {
        if (when === "before host publication") {
          expect(
            readWithCanonicalSessionReaderContinuation(reader, held.receipt, () =>
              readExactSessionEntryRowValidated(reader, healthy),
            )?.entry.sessionId,
          ).toBe("healthy");
          restore = replaceDatabasePath(database.path);
          expect(database.db.isOpen).toBe(true);
          expect(() => held.assertCurrent()).toThrow("no longer current");
          expect(captureCanonicalSessionReaderContinuation(database)).toBeUndefined();
        } else {
          expect(() =>
            readWithCanonicalSessionReaderContinuation(reader, held.receipt, () => {
              const result = readExactSessionEntryRowValidated(reader, healthy);
              restore = replaceDatabasePath(database.path);
              expect(reader.db.isOpen).toBe(true);
              return result;
            }),
          ).toThrow("no longer current");
        }
      } finally {
        restore?.();
        held.release();
      }
    });
  },
);
