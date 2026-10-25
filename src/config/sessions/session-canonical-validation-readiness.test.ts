import { spawnSync } from "node:child_process";
import { renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
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
import { markCanonicalSessionValidationPending } from "./session-canonical-key.js";
import { certifySessionCanonicalValidationPending as certify } from "./session-canonical-validation-readiness.js";
import { hasPendingCanonicalSessionValidation } from "./session-canonical-validation.js";

afterEach(() => vi.restoreAllMocks());

function observeWorker(
  observe: (worker: ReturnType<typeof archiveWorker.createSqliteTranscriptArchiveWorker>) => void,
) {
  const create = archiveWorker.createSqliteTranscriptArchiveWorker;
  return vi
    .spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker")
    .mockImplementation((data, locations) => {
      const worker = create(data, locations);
      observe(worker);
      return worker;
    });
}

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
    if (count > 0) {
      markCanonicalSessionValidationPending(database);
    }
    database.db.exec("COMMIT");
  } catch (error) {
    database.db.exec("ROLLBACK");
    throw error;
  }
  return { options, database };
}

function certifyInWorker(options: Parameters<typeof certify>[0]) {
  return withSqliteCanonicalValidationWorker((withWorker) => certify(options, withWorker));
}

it.each(["unchanged", "pending edit", "replacement", "revoked", "unregistered"] as const)(
  "admits only changed or revoked populated stores after a process restart (%s)",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentIds = ["main", "worker-a", "worker-b"];
      for (const agentId of agentIds) {
        const { options } = seedPendingRows(3, 0, agentId);
        await certifyInWorker(options);
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
      // Pending canonical rows retain integrity proof; replacement or revocation loses only main's.
      expect(JSON.parse(result.stdout)).toEqual({
        workers: change === "unchanged" ? 0 : 1,
        integrityReceipts:
          change === "unchanged" || change === "pending edit"
            ? agentIds.length
            : agentIds.length - 1,
      });
    });
  },
);

it("drains a large backlog while admitting foreground writes between batches", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { options, database } = seedPendingRows(260, 16 * 1024);
    const readRows = () =>
      database.db
        .prepare("SELECT session_key, entry_json FROM session_nodes ORDER BY session_key")
        .all();
    const before = readRows();
    const events: string[] = [];
    let foreground: Promise<void> | undefined;
    observeWorker((worker) => {
      worker.on("message", (message: { type: string }) => {
        if (message.type !== "reclaimed") {
          return;
        }
        events.push("batch");
        foreground ??= runOpenClawAgentWriteAdmission(options, () => {
          events.push("foreground");
        });
      });
    });
    await certify(options);
    await foreground;
    expect(events[0]).toBe("batch");
    expect(events.indexOf("foreground")).toBeGreaterThan(0);
    expect(events.lastIndexOf("batch")).toBeGreaterThan(events.indexOf("foreground"));
    expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
    expect(readRows()).toEqual(before);
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
      observeWorker((worker) => {
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
      });
      const assertCurrentOwner =
        change === "startup revoked"
          ? () => {
              if (changed) {
                throw new Error("startup preparation was superseded");
              }
            }
          : undefined;
      await expect(certify(options, undefined, assertCurrentOwner)).rejects.toThrow(
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
      await certify(options);
      const copiedPath = state.statePath("copied-agent.sqlite");
      database.db.prepare("VACUUM INTO ?").run(copiedPath);
      if (invalid) {
        using imported = new DatabaseSync(copiedPath);
        // Untrusted copied derived state cannot certify its own source contents.
        imported.exec(
          "UPDATE session_nodes SET parent_session_key = 'agent:main:changed' WHERE session_key = 'agent:main:pending-0'",
        );
        imported.exec("DELETE FROM session_canonical_validation_pending");
      }
      const copiedOptions = { ...options, path: copiedPath };
      const copied = openOpenClawAgentDatabase(copiedOptions);
      expect(hasPendingCanonicalSessionValidation(copied)).toBe(false);
      expect(hasOpenClawAgentCanonicalValidation(copied)).toBe(false);
      const result = certify(copiedOptions);
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
    await certifyInWorker(options);
    database.db.exec(`
      UPDATE session_nodes SET parent_session_key = 'agent:main:changed';
      DELETE FROM session_canonical_validation_pending;
    `);
    invalidateOpenClawAgentDatabaseValidation(database.path);
    await expect(certifyInWorker(options)).rejects.toThrow("invalid persisted session row");
    expect(hasPendingCanonicalSessionValidation(database)).toBe(true);
  });
});

it("settles concurrent certification and retries after success or failure", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { options, database } = seedPendingRows(1);
    const entered = createDeferredCore();
    let holdNext = false;
    let resume: (() => void) | undefined;
    observeWorker((worker) => {
      const post = worker.postMessage.bind(worker);
      vi.spyOn(worker, "postMessage").mockImplementation((message: unknown, ...args) => {
        if (holdNext && isRecord(message) && message.type === "canonical-validation") {
          holdNext = false;
          resume = () => post(message, ...args);
          entered.resolve();
          return;
        }
        post(message, ...args);
      });
    });
    await certify(options);
    const observed = observeHostDataSql();
    try {
      await certify(options);
      expect(
        observed.queries.filter((query) => /session_canonical_validation_pending/i.test(query)),
      ).toEqual([]);
    } finally {
      observed.restore();
    }
    const dirty = () => {
      markCanonicalSessionValidationPending(database);
      database.db.exec("UPDATE session_nodes SET entry_json = entry_json || ' '");
    };
    dirty();
    holdNext = true;
    const pending = [certify(options)];
    try {
      await entered.promise;
      pending.push(...Array.from({ length: 3 }, () => certify(options)));
      resume?.();
      resume = undefined;
      await Promise.all(pending);
      expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
      dirty();
      await certify(options);
      expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
      markCanonicalSessionValidationPending(database);
      database.db.exec("UPDATE session_nodes SET parent_session_key = 'agent:main:changed'");
      const failures = await Promise.allSettled(Array.from({ length: 3 }, () => certify(options)));
      expect(failures).toEqual(
        Array.from({ length: 3 }, () => ({
          status: "rejected",
          reason: expect.objectContaining({
            message: expect.stringContaining("invalid persisted session row"),
          }),
        })),
      );
      expect(hasPendingCanonicalSessionValidation(database)).toBe(true);
      database.db.exec("UPDATE session_nodes SET parent_session_key = NULL");
      await certify(options);
      expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
    } finally {
      resume?.();
      await Promise.allSettled(pending);
    }
  });
});
