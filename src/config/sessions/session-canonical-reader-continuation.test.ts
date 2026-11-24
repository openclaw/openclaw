import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { assert, expect, it } from "vitest";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import * as agentDb from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { readExactSessionEntryRowValidated } from "./session-accessor.sqlite-entry-read.js";
import * as canonical from "./session-canonical-key.js";
import { seedCanonicalSessionValidation } from "./session-canonical-validation.js";

const healthy = "agent:main:healthy";
const damaged = "agent:main:damaged";
type FixtureDatabase = ReturnType<typeof agentDb.openOpenClawAgentDatabase>;
type FixtureReader = Extract<
  ReturnType<typeof openOpenClawAgentDatabaseReadOnly>,
  { found: true }
>["database"];
type Held = ReturnType<typeof capture>;

function capture(database: FixtureDatabase) {
  const continuation = canonical.captureCanonicalSessionReaderContinuation(database);
  assert(continuation, "Expected an existing committed reader admission");
  return Object.assign(continuation, { [Symbol.dispose]: continuation.release });
}

function corrupt(database: FixtureDatabase) {
  // Keep the held reader receipt while seeding the unvalidated-row fixture.
  runSqliteImmediateTransactionSync(database.db, () => seedCanonicalSessionValidation(database));
  database.db
    .prepare("UPDATE session_nodes SET entry_json = '{', entry_valid = 1 WHERE session_key = ?")
    .run(damaged);
}

function readHealthy(reader: FixtureReader, receipt: Held["receipt"], during?: () => void) {
  return canonical.readWithCanonicalSessionReaderContinuation(reader, receipt, () => {
    const result = readExactSessionEntryRowValidated(reader, healthy);
    during?.();
    return result;
  });
}

function replaceDatabasePath(pathname: string): () => void {
  const replacementPath = `${pathname}.continuation-new`;
  const displacedPath = `${pathname}.continuation-old`;
  {
    using replacement = new DatabaseSync(replacementPath);
    replacement.exec("CREATE TABLE replacement_marker (value TEXT)");
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
    reader: FixtureReader;
    options: { agentId: string; env: NodeJS.ProcessEnv };
  }) => void | Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    for (const sessionId of ["healthy", "damaged"]) {
      replaceSessionEntrySync(
        { ...options, sessionKey: `agent:main:${sessionId}` },
        { sessionId, updatedAt: 1 },
      );
    }
    const database = agentDb.openOpenClawAgentDatabase(options);
    canonical.assertCanonicalSqliteSessionKeysCurrent(database);
    const opened = openOpenClawAgentDatabaseReadOnly(options);
    assert(opened.found, "Expected the seeded read-only database");
    const reader = opened.database;
    try {
      await run({ database, reader, options });
    } finally {
      reader.close();
    }
  });
}

it("captures and revalidates existing admission", () =>
  withReaders(({ database, reader, options }) => {
    expect(canonical.captureCanonicalSessionReaderContinuation(reader)).toBeUndefined();
    agentDb.runOpenClawAgentWriteTransaction(() => {
      expect(canonical.captureCanonicalSessionReaderContinuation(database)).toBeUndefined();
    }, options);
    const held = capture(database);
    held.assertCurrent();
    held.release();
    expect(() => held.assertCurrent()).toThrow("no longer current");
  }));

it.each(["release", "readiness", "post-commit release"])(
  "refuses publication when %s changes before publication",
  (change) =>
    withReaders(({ database, reader }) => {
      using held = capture(database);
      corrupt(database);
      expect(() =>
        readHealthy(reader, structuredClone(held.receipt), () => {
          if (change === "release") {
            held.release();
          } else if (change === "readiness") {
            Atomics.store(new Int32Array(held.receipt.validation.canonicalReady), 0, 0);
          } else {
            expect(deferSqlitePostCommitPublication(reader.db, held.release)).toBe(true);
          }
        }),
      ).toThrow("no longer current");
    }),
);

it("does not export a proof whose readiness changed at its admission commit", () =>
  withReaders(({ database, options }) => {
    using before = capture(database);
    Atomics.store(new Int32Array(before.receipt.validation.canonicalReady), 0, 0);
    agentDb.runOpenClawAgentWriteTransaction((current) => {
      canonical.assertCanonicalSqliteSessionKeysCurrent(current);
    }, options);
    expect(Atomics.load(new Int32Array(before.receipt.validation.canonicalReady), 0)).toBe(1);
    expect(canonical.captureCanonicalSessionReaderContinuation(database)).toBeUndefined();
    canonical.assertCanonicalSqliteSessionKeysCurrent(database);
    capture(database).release();
  }));

it.each([
  { ending: "rollback", admitted: false },
  { ending: "manual commit", admitted: false },
  { ending: "invalidate before commit", admitted: false },
  { ending: "rollback", admitted: true },
])(
  "retains only committed admission after $ending (previous admission: $admitted)",
  ({ ending, admitted }) =>
    withReaders(({ database, options }) => {
      using held = admitted ? capture(database) : undefined;
      if (!admitted) {
        agentDb.closeOpenClawAgentDatabaseByPath(database.path);
      }
      const current = admitted ? database : agentDb.openOpenClawAgentDatabase(options);
      if (!admitted) {
        expect(canonical.captureCanonicalSessionReaderContinuation(current)).toBeUndefined();
      }
      if (ending === "manual commit") {
        current.db.exec("BEGIN");
        try {
          canonical.assertCanonicalSqliteSessionKeysCurrent(current);
          expect(canonical.captureCanonicalSessionReaderContinuation(current)).toBeUndefined();
        } finally {
          current.db.exec("COMMIT");
        }
      } else {
        const failure = admitted ? "rollback policy" : "abandoned admission";
        const run = () =>
          agentDb.runOpenClawAgentWriteTransaction((writer) => {
            if (admitted) {
              canonical.setCanonicalSqliteSessionMainKey(writer, "custom");
            }
            canonical.assertCanonicalSqliteSessionKeysCurrent(writer);
            expect(canonical.captureCanonicalSessionReaderContinuation(writer)).toBeUndefined();
            if (ending === "rollback") {
              throw new Error(failure);
            }
            canonical.setCanonicalSqliteSessionMainKey(writer, "custom");
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
        canonical.assertCanonicalSqliteSessionKeysCurrent(current);
        const next = capture(current);
        next.assertCurrent();
        next.release();
      } else {
        expect(canonical.captureCanonicalSessionReaderContinuation(current)).toBeUndefined();
      }
    }),
);

// POSIX permits replacing a pathname while both native connections remain open.
it.runIf(process.platform !== "win32").each(["before host publication", "before worker return"])(
  "rejects physical replacement %s while the original handles remain open",
  (when) =>
    withReaders(({ database, reader }) => {
      using held = capture(database);
      let restore: (() => void) | undefined;
      corrupt(database);
      try {
        if (when === "before host publication") {
          expect(readHealthy(reader, held.receipt)?.entry.sessionId).toBe("healthy");
          restore = replaceDatabasePath(database.path);
          expect(database.db.isOpen).toBe(true);
          expect(() => held.assertCurrent()).toThrow("no longer current");
          expect(canonical.captureCanonicalSessionReaderContinuation(database)).toBeUndefined();
        } else {
          expect(() =>
            readHealthy(reader, held.receipt, () => {
              restore = replaceDatabasePath(database.path);
              expect(reader.db.isOpen).toBe(true);
            }),
          ).toThrow("no longer current");
        }
      } finally {
        restore?.();
      }
    }),
);

// POSIX keeps the original handles open after replacement; the async host must
// compare the path again before publishing evidence from their continuation.
it.runIf(process.platform !== "win32")(
  "rejects physical replacement at async host publication",
  () =>
    withReaders(async ({ database, reader }) => {
      const held = await canonical.prepareCanonicalSessionReaderContinuation(database);
      assert(held, "Expected an existing committed reader admission");
      let restore: (() => void) | undefined;
      try {
        corrupt(database);
        expect(readHealthy(reader, held.receipt)?.entry.sessionId).toBe("healthy");
        restore = replaceDatabasePath(database.path);
        expect(database.db.isOpen).toBe(true);
        await expect(held.prepareCurrent()).rejects.toThrow("no longer current");
        expect(await canonical.prepareCanonicalSessionReaderContinuation(database)).toBeUndefined();
      } finally {
        restore?.();
        held.release();
      }
    }),
);

it.each(["capture", "publication"] as const)(
  "refuses a native owner closed during async %s observation",
  (stage) =>
    withReaders(async ({ database }) => {
      // Confirm the actual admitted handle before exercising its close owner.
      capture(database).release();
      const held =
        stage === "publication"
          ? await canonical.prepareCanonicalSessionReaderContinuation(database)
          : undefined;
      if (stage === "publication") {
        assert(held, "Expected an existing committed reader admission");
      }
      let observing: Promise<unknown> | undefined;
      try {
        observing = held
          ? held.prepareCurrent()
          : canonical.prepareCanonicalSessionReaderContinuation(database);
        // The async stat is submitted before this call; no callback can resume
        // before this same-turn native close, so no arbitrary timer is involved.
        expect(agentDb.closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
        expect(database.db.isOpen).toBe(false);
        if (held) {
          await expect(observing).rejects.toThrow("no longer current");
        } else {
          expect(await observing).toBeUndefined();
        }
      } finally {
        await Promise.allSettled(observing ? [observing] : []);
        held?.release();
      }
    }),
);
