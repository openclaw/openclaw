import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  disposeNodeSqliteDependents,
  registerNodeSqliteDisposeCallback,
} from "../../infra/kysely-sync-cache-state.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
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
  await withReaders(({ database }) => {
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

it("keeps the transaction owner's synchronous callback guard", async () => {
  await withReaders(({ database, reader }) => {
    const held = capture(database);
    corrupt(database);
    try {
      expect(() =>
        readWithCanonicalSessionReaderContinuation(reader, held.receipt, () =>
          Promise.resolve(readExactSessionEntryRowValidated(reader, healthy)),
        ),
      ).toThrow("must be synchronous");
      expect(reader.db.isTransaction).toBe(false);
    } finally {
      held.release();
    }
  });
});

it.each([
  "release",
  "native close",
  "native dispose",
  "replacement",
  "main key",
  "validation",
  "readiness",
  "admission replacement",
])("preserves strict fresh admission after %s revokes the continuation", async (reason) => {
  await withReaders(({ database, reader }) => {
    const held = capture(database);
    const receipt = structuredClone(held.receipt);
    if (reason === "admission replacement") {
      database.db.exec("UPDATE session_key_contract SET main_key = 'custom' WHERE id = 1");
      assertCanonicalSqliteSessionKeysCurrent(database);
    }
    corrupt(database);
    if (reason === "release") {
      held.release();
    }
    if (reason === "native close") {
      database.db.close();
    }
    if (reason === "native dispose") {
      database.db[Symbol.dispose]();
    }
    if (reason === "replacement") {
      disposeNodeSqliteDependents(database.db, "replace");
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
      expect(() => held.assertCurrent()).toThrow("no longer current");
      expect(() =>
        readWithCanonicalSessionReaderContinuation(reader, receipt, () =>
          readExactSessionEntryRowValidated(reader, healthy),
        ),
      ).toThrow("openclaw doctor --fix");
    } finally {
      held.release();
    }
  });
});

it("revokes before native disposal while the source connection is still open", async () => {
  await withReaders(({ database }) => {
    const held = capture(database);
    const observations: Array<{ open: boolean; live: number }> = [];
    const stop = registerNodeSqliteDisposeCallback(database.db, () => {
      observations.push({
        open: database.db.isOpen,
        live: Atomics.load(new Int32Array(held.receipt.live), 0),
      });
    });
    try {
      closeOpenClawAgentDatabaseByPath(database.path);
      expect(observations).toContainEqual({ open: true, live: 0 });
    } finally {
      stop();
      held.release();
    }
  });
});

it.each(["release", "readiness"])(
  "refuses publication when %s changes inside the read",
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
            } else {
              Atomics.store(new Int32Array(held.receipt.validation.canonicalReady), 0, 0);
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

it("checks the worker's current main-key policy rather than a still-live old receipt", async () => {
  await withReaders(({ database, reader }) => {
    const held = capture(database);
    corrupt(database);
    database.db.exec("UPDATE session_key_contract SET main_key = 'custom' WHERE id = 1");
    try {
      expect(Atomics.load(new Int32Array(held.receipt.live), 0)).toBe(1);
      expect(() =>
        readWithCanonicalSessionReaderContinuation(reader, held.receipt, () =>
          readExactSessionEntryRowValidated(reader, healthy),
        ),
      ).toThrow("openclaw doctor --fix");
    } finally {
      held.release();
    }
  });
});

it("rechecks continuation lifetime after read transaction publications", async () => {
  await withReaders(({ database, reader }) => {
    const held = capture(database);
    corrupt(database);
    try {
      expect(() =>
        readWithCanonicalSessionReaderContinuation(reader, held.receipt, () => {
          const value = readExactSessionEntryRowValidated(reader, healthy);
          expect(deferSqlitePostCommitPublication(reader.db, held.release)).toBe(true);
          return value;
        }),
      ).toThrow("no longer current");
    } finally {
      held.release();
    }
  });
});

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

it("does not capture an unadmitted connection or a warm connection inside a transaction", async () => {
  await withReaders(({ database, reader, options }) => {
    expect(captureCanonicalSessionReaderContinuation(reader)).toBeUndefined();
    runOpenClawAgentWriteTransaction(() => {
      expect(captureCanonicalSessionReaderContinuation(database)).toBeUndefined();
    }, options);
    capture(database).release();
  });
});

it.each(["rollback", "manual commit", "invalidate before commit"])(
  "does not export staged admission after %s",
  async (ending) => {
    await withReaders(({ database, options }) => {
      closeOpenClawAgentDatabaseByPath(database.path);
      const reopened = openOpenClawAgentDatabase(options);
      expect(captureCanonicalSessionReaderContinuation(reopened)).toBeUndefined();
      if (ending === "manual commit") {
        reopened.db.exec("BEGIN");
        try {
          assertCanonicalSqliteSessionKeysCurrent(reopened);
          expect(captureCanonicalSessionReaderContinuation(reopened)).toBeUndefined();
        } finally {
          reopened.db.exec("COMMIT");
        }
      } else {
        const run = () =>
          runOpenClawAgentWriteTransaction((current) => {
            assertCanonicalSqliteSessionKeysCurrent(current);
            expect(captureCanonicalSessionReaderContinuation(current)).toBeUndefined();
            if (ending === "rollback") {
              throw new Error("abandoned admission");
            }
            setCanonicalSqliteSessionMainKey(current, "custom");
          }, options);
        if (ending === "rollback") {
          expect(run).toThrow("abandoned admission");
        } else {
          run();
        }
      }
      expect(captureCanonicalSessionReaderContinuation(reopened)).toBeUndefined();
    });
  },
);

it("restores committed admission on rollback without resurrecting old continuations", async () => {
  await withReaders(({ database, options }) => {
    const old = capture(database);
    expect(() =>
      runOpenClawAgentWriteTransaction((current) => {
        current.db.exec("UPDATE session_key_contract SET main_key = 'custom' WHERE id = 1");
        assertCanonicalSqliteSessionKeysCurrent(current);
        expect(captureCanonicalSessionReaderContinuation(current)).toBeUndefined();
        throw new Error("rollback policy");
      }, options),
    ).toThrow("rollback policy");
    expect(() => old.assertCurrent()).toThrow("no longer current");
    const next = capture(database);
    next.assertCurrent();
    next.release();
    old.release();
  });
});

it("keeps an already active worker transaction on the strict admission path", async () => {
  await withReaders(({ database, reader }) => {
    const held = capture(database);
    corrupt(database);
    reader.db.exec("BEGIN");
    try {
      expect(() =>
        readWithCanonicalSessionReaderContinuation(reader, held.receipt, () =>
          readExactSessionEntryRowValidated(reader, healthy),
        ),
      ).toThrow("openclaw doctor --fix");
    } finally {
      reader.db.exec("ROLLBACK");
      held.release();
    }
  });
});

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

it.each(["COMMIT", "ROLLBACK"])(
  "revokes prior continuations when unmanaged admission cannot stage before %s",
  async (ending) => {
    await withReaders(({ database }) => {
      const held = capture(database);
      database.db.exec("BEGIN");
      try {
        database.db.exec("UPDATE session_key_contract SET main_key = 'custom' WHERE id = 1");
        assertCanonicalSqliteSessionKeysCurrent(database);
        expect(Atomics.load(new Int32Array(held.receipt.live), 0)).toBe(0);
      } finally {
        database.db.exec(ending);
      }
      expect(() => held.assertCurrent()).toThrow("no longer current");
      expect(captureCanonicalSessionReaderContinuation(database)).toBeUndefined();
      held.release();
    });
  },
);
