import assert from "node:assert/strict";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { WorkerOptions } from "node:worker_threads";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import * as sessions from "../../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../../../state/openclaw-agent-db-validation-cache.js";
import * as db from "../../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { retainSessionListForegroundWork } from "../../session-projection-work.js";
import { writeSessionStore } from "../../test-helpers.js";
import * as fixtures from "../../test/server-sessions.test-helpers.js";

const reclamation = vi.hoisted(() => ({
  gate: undefined as SharedArrayBuffer | undefined,
  databasePath: undefined as string | undefined,
  exitCodes: [] as number[],
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options: WorkerOptions = {}) {
        const { workerData: data, execArgv = [] } = options;
        const gate = reclamation.gate;
        const observed = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        const preload = `
            import { realpathSync } from 'node:fs';
            import { DatabaseSync } from 'node:sqlite';
            import { workerData } from 'node:worker_threads';
            const gate = new Int32Array(workerData.reclamationTestGate);
            const observed = new Int32Array(workerData.reclamationTestObserved);
            const databasePath = realpathSync(workerData.reclamationTestDatabasePath);
            const validated = new WeakSet();
            const prepare = DatabaseSync.prototype.prepare;
            DatabaseSync.prototype.prepare = function (sql) {
              const statement = prepare.call(this, sql);
              const integrityCheck = sql.startsWith('PRAGMA integrity_check') || sql.startsWith('PRAGMA quick_check');
              if (!integrityCheck && !sql.startsWith('PRAGMA foreign_key_check')) return statement;
              if (!prepare.call(this, 'PRAGMA database_list').all().some(
                (row) => row.name === 'main' && row.file && realpathSync(row.file) === databasePath,
              )) return statement;
              const database = this;
              if (integrityCheck) {
                const all = statement.all.bind(statement);
                statement.all = (...args) => {
                  Atomics.store(observed, 0, 1);
                  Atomics.add(gate, 0, 1);
                  if (Atomics.wait(gate, 1, 0, 15000) === 'timed-out') {
                    throw new Error('reclamation test gate was not released');
                  }
                  const result = all(...args);
                  validated.add(database);
                  Atomics.add(gate, 2, 1);
                  return result;
                };
              } else {
                const iterate = statement.iterate.bind(statement);
                statement.iterate = function* (...args) {
                  yield* iterate(...args);
                  if (validated.has(database)) Atomics.add(gate, 3, 1);
                };
              }
              return statement;
            };
          `;
        super(
          filename,
          gate
            ? {
                ...options,
                workerData: {
                  ...data,
                  reclamationTestGate: gate,
                  reclamationTestObserved: observed.buffer,
                  reclamationTestDatabasePath: reclamation.databasePath,
                },
                execArgv: [
                  ...execArgv,
                  "--import",
                  `data:text/javascript,${encodeURIComponent(preload)}`,
                ],
              }
            : options,
        );
        if (gate) {
          this.once("exit", (code) => {
            if (Atomics.load(observed, 0)) {
              reclamation.exitCodes.push(code);
            }
          });
        }
      }
    },
  };
});

const { createSessionStoreDir } = fixtures.setupGatewaySessionsTestHarness();

afterEach(async () => {
  await db.closeOpenClawAgentDatabasesAsync();
  reclamation.gate = undefined;
  reclamation.databasePath = undefined;
  reclamation.exitCodes = [];
  db.closeOpenClawAgentDatabasesForTest();
});

function holdReclamationValidation(databasePath: string) {
  const gate = new Int32Array(new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));
  reclamation.gate = gate.buffer;
  reclamation.databasePath = databasePath;
  const pending: Promise<unknown>[] = [];
  const release = () => {
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
  };
  return {
    gate,
    release,
    own<T>(operation: Promise<T>): Promise<T> {
      pending.push(operation);
      void operation.catch(() => {});
      return operation;
    },
    async entered(operation: Promise<unknown>, signal: AbortSignal) {
      const wait = { done: false };
      const held = (async () => {
        while (Atomics.load(gate, 0) === 0 && !wait.done && !signal.aborted) {
          await yieldToEventLoop();
        }
        return Atomics.load(gate, 0) > 0 ? "held" : undefined;
      })();
      try {
        expect(await Promise.race([held, operation])).toBe("held");
      } finally {
        wait.done = true;
        await held;
      }
    },
    async [Symbol.asyncDispose]() {
      release();
      await Promise.allSettled(pending);
      await db.closeOpenClawAgentDatabasesAsync();
    },
  };
}

test("sessions.delete rejects revoked authority before repair", async ({ signal }) => {
  // This test invokes the lifecycle owner directly instead of the foreground RPC dispatcher.
  onTestFinished(retainSessionListForegroundWork());
  const { storePath } = await createSessionStoreDir();
  const sessionId = "validation-revoked";
  const sessionKey = `agent:main:${sessionId}`;
  const scope = { agentId: "main", sessionKey, sessionId, storePath };
  await writeSessionStore({
    storePath,
    entries: { [sessionKey]: fixtures.sessionStoreEntry(sessionId) },
  });
  // Empty transcripts bypass reclamation validation.
  await fixtures.seedLinearSessionTranscript({ ...scope, contents: ["retained transcript"] });
  const { path } = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  const options = { agentId: "main", path };
  const read = () => sessions.loadSessionEntry(scope);
  const originalEntry = read();
  const originalTranscript = await fixtures.loadSeededTranscriptEvents(scope);
  await db.closeOpenClawAgentDatabaseByPathAsync(options.path, "main");
  const database = db.openOpenClawAgentDatabase(options);
  const leases = openOpenClawStateDatabase().db.prepare(
    "SELECT lease_id FROM agent_database_leases WHERE path = ? ORDER BY lease_id",
  );
  const readLeases = () => leases.all(database.path);
  const originalLeases = readLeases();
  expect(originalLeases).toHaveLength(1);
  database.db.exec("DROP INDEX idx_agent_cache_expiry");
  invalidateOpenClawAgentDatabaseValidation(database.path);
  const readRepairIndex = () =>
    database.db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?")
      .get("idx_agent_cache_expiry");
  expect(readRepairIndex()).toBeUndefined();
  await using validation = holdReclamationValidation(database.path);
  const revoked = "caller authority revoked during Worker validation";
  let authorized = true;
  const deletion = validation.own(
    sessions.deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      commitGuard: () => assert(authorized, revoked),
    }),
  );
  await validation.entered(deletion, signal);
  expect(readRepairIndex()).toBeUndefined();
  expect(db.openOpenClawAgentDatabase(options)).toBe(database);
  expect(database.db.isOpen).toBe(true);
  expect(readLeases()).toHaveLength(originalLeases.length + 1);
  authorized = false;
  validation.release();

  await expect(deletion).rejects.toThrow(revoked);
  expect(db.openOpenClawAgentDatabase(options)).toBe(database);
  expect(read()).toEqual(originalEntry);
  await expect(fixtures.loadSeededTranscriptEvents(scope)).resolves.toEqual(originalTranscript);
  expect(Atomics.load(validation.gate, 2)).toBeGreaterThan(0);
  expect(Atomics.load(validation.gate, 3)).toBeGreaterThan(0);
  expect(readRepairIndex()).toBeUndefined();
  // Rejected validation terminates once; closing the host must not terminate it again.
  expect(reclamation.exitCodes).toEqual([1]);
  expect(readLeases()).toEqual(originalLeases);
  await db.closeOpenClawAgentDatabasesAsync();
  expect(reclamation.exitCodes).toEqual([1]);
  expect(readLeases()).toEqual([]);
});
