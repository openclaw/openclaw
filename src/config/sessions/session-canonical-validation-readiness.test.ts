import { spawnSync } from "node:child_process";
import { renameSync } from "node:fs";
import { backup, DatabaseSync, StatementSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabases,
} from "../../state/openclaw-agent-db-lifecycle.js";
import {
  hasOpenClawAgentCanonicalValidation,
  invalidateOpenClawAgentDatabaseValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import { withSqliteCanonicalValidationWorker } from "./session-accessor.sqlite-reclamation-worker.js";
import {
  markCanonicalSessionValidationPending,
  assertCanonicalSqliteSessionKeysCurrent,
} from "./session-canonical-key.js";
import { withCanonicalSessionValidationDeferral } from "./session-canonical-validation-deferral.js";
import { certifySessionCanonicalValidationPending } from "./session-canonical-validation-readiness.js";
import { hasPendingCanonicalSessionValidation } from "./session-canonical-validation.js";

afterEach(() => vi.restoreAllMocks());

function seedPendingRows(count: number, textBytes = 0, agentId = "main") {
  const options = { agentId };
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
        `agent:${agentId}:${sessionId}`,
        sessionId,
        JSON.stringify({ sessionId, updatedAt: 1, lastRunError: "x".repeat(textBytes) }),
      );
    }
    database.db.exec(
      "INSERT INTO session_canonical_validation_pending SELECT session_key FROM session_nodes",
    );
    database.db.exec("COMMIT");
  } catch (error) {
    database.db.exec("ROLLBACK");
    throw error;
  }
  return { options, database };
}

it.each(["pending rows", "revoked receipt"] as const)(
  "certifies captured runtime work without caller-thread SQL (%s)",
  async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { database } = seedPendingRows(1);
      const deferred = withCanonicalSessionValidationDeferral(() =>
        assertCanonicalSqliteSessionKeysCurrent(database),
      );
      expect(deferred.kind).toBe("pending");
      if (deferred.kind !== "pending") {
        throw new Error("Fixture did not discover canonical work");
      }
      if (scenario === "revoked receipt") {
        database.db.exec(`
          UPDATE session_nodes SET parent_session_key = 'agent:main:changed';
          DELETE FROM session_canonical_validation_pending;
        `);
        invalidateOpenClawAgentDatabaseValidation(database.path);
      }
      const executed: string[] = [];
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      const statements = (["get", "all", "run", "iterate"] as const).map((method) => {
        const original = StatementSync.prototype[method];
        return vi.spyOn(StatementSync.prototype, method).mockImplementation(
          new Proxy(original, {
            apply(target, receiver: StatementSync, args) {
              executed.push(receiver.sourceSQL);
              return Reflect.apply(target, receiver, args);
            },
          }),
        );
      });
      try {
        const certification = certifySessionCanonicalValidationPending(deferred.database);
        if (scenario === "revoked receipt") {
          await expect(certification).rejects.toThrow("invalid persisted session row");
        } else {
          await certification;
        }
        expect(executed).toEqual([]);
        expect(exec).not.toHaveBeenCalled();
      } finally {
        exec.mockRestore();
        statements.forEach((statement) => statement.mockRestore());
      }
      expect(hasPendingCanonicalSessionValidation(database)).toBe(scenario === "revoked receipt");
    });
  },
);

it("refuses replacement schema drift before reusing a warm canonical readiness receipt", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { options, database } = seedPendingRows(0);
    expect(hasOpenClawAgentCanonicalValidation(database)).toBe(true);
    expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
    await certifySessionCanonicalValidationPending(options);
    const replacement = `${database.path}.replacement`;
    await backup(database.db, replacement);
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    const peer = new DatabaseSync(replacement);
    try {
      peer.exec(
        "CREATE TRIGGER unexpected_session_trigger AFTER INSERT ON session_nodes BEGIN SELECT 1; END",
      );
    } finally {
      peer.close();
    }
    renameSync(replacement, database.path);
    await expect(certifySessionCanonicalValidationPending(options)).rejects.toThrow(
      /unexpected_session_trigger.*openclaw doctor --fix/u,
    );
  });
});

it.each(["unchanged", "pending edit", "replacement", "revoked", "unregistered"] as const)(
  "admits only changed or revoked populated stores after a process restart (%s)",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentIds = ["main", "worker-a", "worker-b"];
      for (const agentId of agentIds) {
        const { options } = seedPendingRows(3, 0, agentId);
        await withSqliteCanonicalValidationWorker((withWorker) =>
          certifySessionCanonicalValidationPending(options, withWorker),
        );
      }
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const copiedPath = state.statePath("replacement.sqlite");
      if (change === "replacement") {
        database.db.prepare("VACUUM INTO ?").run(copiedPath);
      } else if (change === "pending edit") {
        markCanonicalSessionValidationPending(database);
        markCanonicalSessionValidationPending(database);
        database.db.exec("UPDATE session_nodes SET parent_session_key = 'agent:main:changed'");
      }
      closeOpenClawAgentDatabases(state.stateDir);
      if (change === "replacement") {
        renameSync(copiedPath, database.path);
      }
      const readinessUrl = resolveRuntimeWorkerUrl(
        sessionNativeProcessEntrypoints.canonicalReadiness,
      );
      const readiness = readinessUrl.href;
      const reader = resolveRuntimeWorkerUrl(sessionNativeProcessEntrypoints.databaseReadOnly).href;
      const validation = resolveRuntimeWorkerUrl(
        sessionNativeProcessEntrypoints.databaseValidation,
      ).href;
      const registry = resolveRuntimeWorkerUrl(
        sessionNativeProcessEntrypoints.databaseRegistry,
      ).href;
      const result = spawnSync(
        process.execPath,
        [
          ...resolveRuntimeWorkerArgv(readinessUrl).slice(0, -1),
          "--input-type=module",
          "--eval",
          `import { certifySessionCanonicalValidationPending } from ${JSON.stringify(readiness)};
           import { openOpenClawAgentDatabaseReadOnly } from ${JSON.stringify(reader)};
           import { unregisterOpenClawAgentDatabases } from ${JSON.stringify(registry)};
           import {
             getOpenClawAgentDatabaseValidation,
             invalidateOpenClawAgentDatabaseValidation,
           } from ${JSON.stringify(validation)};
           if (${JSON.stringify(change)} === "revoked") {
             invalidateOpenClawAgentDatabaseValidation(${JSON.stringify(database.path)});
           } else if (${JSON.stringify(change)} === "unregistered") {
             unregisterOpenClawAgentDatabases({ agentId: "main" });
           }
           let workers = 0;
           let integrityReceipts = 0;
         const observed = new Error("canonical worker requested");
           for (const agentId of ${JSON.stringify(agentIds)}) {
             try {
               await certifySessionCanonicalValidationPending({ agentId }, async () => {
                 workers++;
                 throw observed;
               });
             } catch (error) {
               if (error !== observed) throw error;
             }
             const opened = openOpenClawAgentDatabaseReadOnly({ agentId });
             if (!opened.found) throw new Error("fixture database missing");
             if (getOpenClawAgentDatabaseValidation(opened.database)) integrityReceipts++;
             opened.database.close();
           }
           process.stdout.write(JSON.stringify({ workers, integrityReceipts }));`,
        ],
        { env: { ...process.env, ...state.env }, encoding: "utf8", timeout: 30_000 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        workers: change === "unchanged" ? 0 : 1,
        integrityReceipts: 0,
      });
    });
  },
);

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

it.each(["row changed", "receipt revoked", "startup revoked"] as const)(
  "retains validation authority when %s during worker admission",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { options, database } = seedPendingRows(1);
      if (change === "startup revoked") {
        invalidateOpenClawAgentDatabaseValidation(database.path);
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
      }
      let changed = false;
      let markerRetainedAfterFirstBatch = false;
      const createWorker = archiveWorker.createSqliteTranscriptArchiveWorker;
      vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
        const worker = createWorker(data);
        worker.on("message", (message: { type: string }) => {
          if (message.type === "admission-request" && !changed) {
            if (change === "row changed") {
              changed = true;
              database.db.exec(
                "UPDATE session_nodes SET parent_session_key = 'agent:main:changed'",
              );
            } else if (change === "startup revoked") {
              changed = true;
            }
          } else if (message.type === "reclaimed") {
            if (change === "row changed") {
              markerRetainedAfterFirstBatch = hasPendingCanonicalSessionValidation(database);
            } else if (change === "receipt revoked") {
              invalidateOpenClawAgentDatabaseValidation(database.path);
            }
          }
        });
        return worker;
      });
      const assertCurrentOwner =
        change === "startup revoked"
          ? () => {
              if (changed) {
                throw new Error("startup preparation was superseded");
              }
            }
          : undefined;
      await expect(
        certifySessionCanonicalValidationPending(options, undefined, assertCurrentOwner),
      ).rejects.toThrow(
        {
          "row changed": "invalid persisted session row",
          "receipt revoked": "database owner is no longer current",
          "startup revoked": "startup preparation was superseded",
        }[change],
      );
      if (change !== "receipt revoked") {
        expect(changed).toBe(true);
        expect(hasPendingCanonicalSessionValidation(database)).toBe(true);
      }
      if (change === "row changed") {
        expect(markerRetainedAfterFirstBatch).toBe(true);
        expect(database.db.prepare("SELECT parent_session_key FROM session_nodes").get()).toEqual({
          parent_session_key: "agent:main:changed",
        });
      } else {
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
      }
    });
  },
);

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

it("forces a fresh worker to revalidate a canonical receipt revoked by its parent", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { options, database } = seedPendingRows(1);
    await withSqliteCanonicalValidationWorker((withWorker) =>
      certifySessionCanonicalValidationPending(options, withWorker),
    );
    database.db.exec(`
      UPDATE session_nodes SET parent_session_key = 'agent:main:changed';
      DELETE FROM session_canonical_validation_pending;
    `);
    invalidateOpenClawAgentDatabaseValidation(database.path);
    await expect(
      withSqliteCanonicalValidationWorker((withWorker) =>
        certifySessionCanonicalValidationPending(options, withWorker),
      ),
    ).rejects.toThrow("invalid persisted session row");
    expect(hasPendingCanonicalSessionValidation(database)).toBe(true);
  });
});

it("shares active runtime certification without retaining success or failure", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { options, database } = seedPendingRows(1);
    const entered = createDeferredCore();
    let holdNext = false;
    let resume: (() => void) | undefined;
    const jobs = vi.fn();
    const createWorker = archiveWorker.createSqliteTranscriptArchiveWorker;
    vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
      const worker = createWorker(data);
      const post = worker.postMessage.bind(worker);
      vi.spyOn(worker, "postMessage").mockImplementation((message: unknown, ...args) => {
        if (isRecord(message) && message.type === "canonical-validation") {
          jobs();
          if (holdNext) {
            holdNext = false;
            resume = () => post(message, ...args);
            entered.resolve();
            return;
          }
        }
        post(message, ...args);
      });
      return worker;
    });
    await certifySessionCanonicalValidationPending(options);
    jobs.mockClear();
    const dirty = () => {
      markCanonicalSessionValidationPending(database);
      database.db.exec("UPDATE session_nodes SET entry_json = entry_json || ' '");
    };
    dirty();
    holdNext = true;
    const pending = [certifySessionCanonicalValidationPending(options)];
    try {
      await entered.promise;
      pending.push(
        ...Array.from({ length: 3 }, () => certifySessionCanonicalValidationPending(options)),
      );
      resume?.();
      resume = undefined;
      await Promise.all(pending);
      expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
      // One shared drain seeds revoked admission, then certifies its rows.
      expect(jobs).toHaveBeenCalledTimes(2);
      dirty();
      await certifySessionCanonicalValidationPending(options);
      expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
      expect(jobs).toHaveBeenCalledTimes(4);
      markCanonicalSessionValidationPending(database);
      database.db.exec("UPDATE session_nodes SET parent_session_key = 'agent:main:changed'");
      const failures = await Promise.allSettled(
        Array.from({ length: 3 }, () => certifySessionCanonicalValidationPending(options)),
      );
      expect(failures).toEqual(
        Array.from({ length: 3 }, () => ({
          status: "rejected",
          reason: expect.objectContaining({
            message: expect.stringContaining("invalid persisted session row"),
          }),
        })),
      );
      expect(jobs).toHaveBeenCalledTimes(6);
      expect(hasPendingCanonicalSessionValidation(database)).toBe(true);
      database.db.exec("UPDATE session_nodes SET parent_session_key = NULL");
      await certifySessionCanonicalValidationPending(options);
      expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
      expect(jobs).toHaveBeenCalledTimes(8);
    } finally {
      resume?.();
      await Promise.allSettled(pending);
    }
  });
});
