import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { WorkerOptions } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { withTestTimeout } from "../../../../test/helpers/promise.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import { beginSessionWorkAdmission } from "../../../sessions/session-lifecycle-admission.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { retainSessionListForegroundWork } from "../../session-projection-work.js";
import { rpcReq, writeSessionStore } from "../../test-helpers.js";
import {
  loadSeededTranscriptEvents,
  seedLinearSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "../../test/server-sessions.test-helpers.js";

const reclamation = vi.hoisted(() => ({
  gate: undefined as SharedArrayBuffer | undefined,
  databasePath: undefined as string | undefined,
  exits: [] as Promise<number>[],
  exitCodes: [] as number[],
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      private readonly validationGate: SharedArrayBuffer | undefined;
      private observedValidation = false;

      constructor(filename: string | URL, options: WorkerOptions = {}) {
        const gate =
          options.workerData?.operation === "reclaim" || reclamation.databasePath
            ? reclamation.gate
            : undefined;
        let workerOptions = options;
        if (gate) {
          // Hold the real Worker's native validation, with no fake database or
          // production hook. Both checks still execute on this same handle.
          const preload = `
            import { realpathSync } from 'node:fs';
            import { DatabaseSync } from 'node:sqlite';
            import { parentPort, workerData } from 'node:worker_threads';
            const gate = new Int32Array(workerData.reclamationTestGate);
            const databasePath = realpathSync(workerData.reclamationTestDatabasePath);
            const validated = new WeakSet();
            const prepare = DatabaseSync.prototype.prepare;
            DatabaseSync.prototype.prepare = function (sql) {
              const statement = prepare.call(this, sql);
              const integrityCheck = sql.startsWith('PRAGMA integrity_check') || sql.startsWith('PRAGMA quick_check');
              const foreignKeyCheck = sql.startsWith('PRAGMA foreign_key_check');
              if (!integrityCheck && !foreignKeyCheck) {
                return statement;
              }
              const target = prepare.call(this, 'PRAGMA database_list').all().some(
                (row) => row.name === 'main' && row.file && realpathSync(row.file) === databasePath,
              );
              if (!target) return statement;
              const database = this;
              if (integrityCheck) {
                const all = statement.all.bind(statement);
                statement.all = (...args) => {
                  Atomics.add(gate, 0, 1);
                  Atomics.notify(gate, 0);
                  parentPort.postMessage({ type: 'test-reclamation-validation', phase: 'checking' });
                  if (Atomics.wait(gate, 1, 0, 15000) === 'timed-out') {
                    throw new Error('reclamation test gate was not released');
                  }
                  const result = all(...args);
                  validated.add(database);
                  Atomics.add(gate, 2, 1);
                  return result;
                };
              } else if (foreignKeyCheck) {
                const iterate = statement.iterate.bind(statement);
                statement.iterate = function* (...args) {
                  yield* iterate(...args);
                  if (validated.has(database)) Atomics.add(gate, 3, 1);
                };
              }
              return statement;
            };
          `;
          workerOptions = {
            ...options,
            workerData: {
              ...options.workerData,
              reclamationTestGate: gate,
              reclamationTestDatabasePath:
                reclamation.databasePath ?? options.workerData.databaseOptions.path,
            },
            execArgv: [
              ...(options.execArgv ?? []),
              "--import",
              `data:text/javascript,${encodeURIComponent(preload)}`,
            ],
          };
        }
        super(filename, workerOptions);
        this.validationGate = gate;
      }

      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const message = args[0];
        if (
          this.validationGate &&
          event === "message" &&
          args.length === 1 &&
          isRecord(message) &&
          Object.keys(message).length === 2 &&
          message.type === "test-reclamation-validation" &&
          message.phase === "checking"
        ) {
          if (!this.observedValidation) {
            this.observedValidation = true;
            reclamation.exits.push(
              new Promise((resolve) => {
                this.once("exit", (code) => {
                  reclamation.exitCodes.push(code);
                  resolve(code);
                });
              }),
            );
          }
          return true;
        }
        return super.emit(event, ...args);
      }
    },
  };
});

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  reclamation.gate = undefined;
  reclamation.databasePath = undefined;
  reclamation.exits = [];
  reclamation.exitCodes = [];
  closeOpenClawAgentDatabasesForTest();
});

function holdReclamationValidation(databasePath?: string) {
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
    async entered(operation: Promise<unknown>) {
      // RPCs retain their own timeout; an early response must not masquerade as
      // a held native check. The direct lifecycle sibling supplies the same bound.
      const waiting = new AbortController();
      const held = (async () => {
        while (Atomics.load(gate, 0) === 0) {
          if (waiting.signal.aborted) {
            return undefined;
          }
          await yieldToEventLoop();
        }
        return "held";
      })();
      try {
        const result = await Promise.race([held, operation]);
        expect(result).toBe("held");
        expect(Atomics.load(gate, 0)).toBeGreaterThan(0);
      } finally {
        waiting.abort();
        await held;
      }
    },
    async close() {
      release();
      await Promise.allSettled(pending);
      await closeOpenClawAgentDatabasesAsync();
      await Promise.all(reclamation.exits);
    },
  };
}

test("sessions.delete admits unrelated same-store patches during Worker validation", async () => {
  const targetKey = "agent:main:validation-delete";
  const unrelatedKey = "agent:main:validation-patch";
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      [targetKey]: sessionStoreEntry("validation-delete"),
      [unrelatedKey]: sessionStoreEntry("validation-patch"),
    },
    storePath,
  });
  const { ws } = await openClient();
  const validation = holdReclamationValidation();
  const { gate } = validation;
  try {
    expect(await rpcReq(ws, "sessions.patch", { key: unrelatedKey, label: "warm" })).toMatchObject({
      ok: true,
    });
    invalidateOpenClawAgentDatabaseValidation(
      resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
    );
    const deletion = validation.own(rpcReq(ws, "sessions.delete", { key: targetKey }));
    await validation.entered(deletion);
    expect(loadSessionEntry({ sessionKey: targetKey, storePath })?.sessionId).toBe(
      "validation-delete",
    );

    let admissionSettled = false;
    const assertTargetExists = () => {
      if (!loadSessionEntry({ sessionKey: targetKey, storePath })) {
        throw new Error("deleted session cannot accept new work");
      }
    };
    const admission = validation.own(
      beginSessionWorkAdmission({
        scope: storePath,
        identities: [targetKey, "validation-delete"],
        assertAllowed: assertTargetExists,
        revalidateAllowed: assertTargetExists,
      }).then(
        (lease) => {
          lease.release();
          admissionSettled = true;
          return "admitted";
        },
        (error: unknown) => {
          admissionSettled = true;
          return error instanceof Error ? error.message : String(error);
        },
      ),
    );
    const patch = validation.own(
      rpcReq(ws, "sessions.patch", { key: unrelatedKey, label: "progressed" }),
    );
    await expect(
      withTestTimeout(patch, 2_000, "unrelated same-store patch waited for reclamation validation"),
    ).resolves.toMatchObject({ ok: true });
    expect(loadSessionEntry({ sessionKey: unrelatedKey, storePath })?.label).toBe("progressed");
    expect(admissionSettled).toBe(false);
    expect(Atomics.load(gate, 2)).toBe(0);

    validation.release();
    await expect(deletion).resolves.toMatchObject({ ok: true, payload: { deleted: true } });
    await expect(admission).resolves.toBe("deleted session cannot accept new work");
    expect(loadSessionEntry({ sessionKey: targetKey, storePath })).toBeUndefined();
    expect(Atomics.load(gate, 2)).toBeGreaterThan(0);
    expect(Atomics.load(gate, 3)).toBeGreaterThan(0);
    expect(reclamation.exitCodes).toEqual([]);
    await closeOpenClawAgentDatabasesAsync();
    expect(reclamation.exitCodes).toEqual([0]);
  } finally {
    await validation.close();
    ws.close();
  }
});

test("sessions.delete rejects revoked authority before repairing the same database", async () => {
  // This test invokes the lifecycle owner directly instead of the foreground RPC dispatcher.
  onTestFinished(retainSessionListForegroundWork());
  const sessionKey = "agent:main:validation-revoked";
  const sessionId = "validation-revoked";
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) }, storePath });
  const transcriptScope = { agentId: "main", sessionKey, sessionId, storePath };
  await seedLinearSessionTranscript({ ...transcriptScope, contents: ["retained transcript"] });
  const originalEntry = loadSessionEntry(transcriptScope);
  const originalTranscript = await loadSeededTranscriptEvents(transcriptScope);
  const databaseOptions = {
    agentId: "main",
    path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
  };
  const database = openOpenClawAgentDatabase(databaseOptions);
  const stateDatabase = openOpenClawStateDatabase();
  const readLeases = () =>
    stateDatabase.db
      .prepare("SELECT lease_id FROM agent_database_leases WHERE path = ? ORDER BY lease_id")
      .all(database.path);
  const originalLeases = readLeases();
  expect(originalLeases).toHaveLength(1);
  // A late commit guard can roll back deletion but cannot undo an earlier
  // database-open repair. Keep the original cached handle warm throughout.
  database.db.exec("DROP INDEX idx_agent_cache_expiry");
  invalidateOpenClawAgentDatabaseValidation(database.path);
  const readRepairIndex = () =>
    database.db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?")
      .get("idx_agent_cache_expiry");
  expect(readRepairIndex()).toBeUndefined();
  const validation = holdReclamationValidation(database.path);
  let authorized = true;
  let guardCalls = 0;
  try {
    const deletion = validation.own(
      deleteSessionEntryLifecycle({
        archiveTranscript: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        commitGuard: () => {
          guardCalls += 1;
          if (!authorized) {
            throw new Error("caller authority revoked during Worker validation");
          }
        },
      }),
    );
    await validation.entered(
      withTestTimeout(deletion, 10_000, "reclamation Worker did not enter native validation"),
    );
    expect(readRepairIndex()).toBeUndefined();
    expect(openOpenClawAgentDatabase(databaseOptions)).toBe(database);
    expect(database.db.isOpen).toBe(true);
    expect(readLeases()).toHaveLength(originalLeases.length + 1);
    const callsBeforeRevocation = guardCalls;
    authorized = false;
    validation.release();

    await expect(deletion).rejects.toThrow("caller authority revoked during Worker validation");
    expect(guardCalls).toBeGreaterThan(callsBeforeRevocation);
    expect(openOpenClawAgentDatabase(databaseOptions)).toBe(database);
    expect(loadSessionEntry(transcriptScope)).toEqual(originalEntry);
    await expect(loadSeededTranscriptEvents(transcriptScope)).resolves.toEqual(originalTranscript);
    expect(Atomics.load(validation.gate, 2)).toBeGreaterThan(0);
    expect(Atomics.load(validation.gate, 3)).toBeGreaterThan(0);
    // Refused native opening joins broker termination before returning its authority error.
    expect(reclamation.exitCodes).toEqual([1]);
    expect(readLeases()).toEqual(originalLeases);
    expect(readRepairIndex()).toBeUndefined();
    await closeOpenClawAgentDatabasesAsync();
    expect(reclamation.exitCodes).toEqual([1]);
  } finally {
    await validation.close();
  }
});
