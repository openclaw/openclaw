import assert from "node:assert/strict";
import fs from "node:fs";
import { setImmediate } from "node:timers/promises";
import type { Compilable } from "kysely";
import { vi } from "vitest";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import * as storeWriterQueue from "../../shared/store-writer-queue.js";
import type { runQueuedStoreWrite } from "../../shared/store-writer-queue.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

export type SessionHistoryBudgetQueueObservation = {
  mock: {
    calls: Array<Parameters<typeof runQueuedStoreWrite>>;
    results: Array<{ type: string; value: unknown }>;
  };
};

export async function joinSessionHistoryBudgetSweeps(
  spy: SessionHistoryBudgetQueueObservation,
  work: Promise<unknown>[] = [],
): Promise<void> {
  let joined = 0;
  const failures: unknown[] = [];
  for (;;) {
    const pending = spy.mock.calls.flatMap(([params], index) => {
      const outcome = spy.mock.results[index];
      return params.label === "enforceSqliteSessionHistoryDiskBudget" &&
        outcome?.type === "return" &&
        outcome.value instanceof Promise
        ? [outcome.value as Promise<unknown>]
        : [];
    });
    if (joined === pending.length) {
      break;
    }
    const next = pending.slice(joined);
    joined = pending.length;
    work.push(...next);
    failures.push(
      ...(await Promise.allSettled(next)).flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      ),
    );
    // A settled sweep can enqueue a pending-force continuation after a queue barrier.
    await setImmediate();
  }
  if (failures.length) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Session history budget sweeps failed");
  }
}

/** Join the background producer owned by a synthetic mutation before its fixture can close. */
export async function withSessionHistoryBudgetSweepsForTest<T>(run: () => Promise<T>): Promise<T> {
  const queueSpy = vi.spyOn(storeWriterQueue, "runQueuedStoreWrite");
  try {
    // The async wrapper also captures a synchronous throw before run returns its promise.
    const [mutation] = await Promise.allSettled([(async () => run())()]);
    const [maintenance] = await Promise.allSettled([joinSessionHistoryBudgetSweeps(queueSpy)]);
    if (maintenance.status === "rejected") {
      throw mutation.status === "rejected"
        ? new AggregateError(
            [mutation.reason, maintenance.reason],
            "Fixture mutation and maintenance failed",
            { cause: maintenance.reason },
          )
        : maintenance.reason;
    }
    if (mutation.status === "rejected") {
      throw mutation.reason;
    }
    return mutation.value;
  } finally {
    queueSpy.mockRestore();
  }
}

export function createSessionHistoryBudgetFixture(
  readScope: () => { storePath: string; tempDir: string },
) {
  function query<T>(build: (db: ReturnType<typeof getSessionKysely>) => Compilable<T>) {
    const owner = database();
    return executeSqliteQuerySync(owner.db, build(getSessionKysely(owner.db)));
  }
  async function createHistoricalTranscript(params: {
    content: string;
    nextSessionId: string;
    sessionId: string;
    sessionKey: string;
    updatedAt: number;
  }): Promise<void> {
    const { content, nextSessionId, sessionId, sessionKey, updatedAt } = params;
    const resolved = resolveSqliteTranscriptScope({
      sessionId,
      sessionKey,
      storePath: readScope().storePath,
    });
    // Seed through the canonical writers without lifecycle publication or maintenance kicks.
    runOpenClawAgentWriteTransaction((owner) => {
      writeSessionEntry(owner, resolved.sessionKey, { sessionId, updatedAt });
      const appended = appendTranscriptMessageInTransaction(owner, resolved, {
        message: { role: "user", content },
      });
      assert(appended?.result.appended, "Historical transcript fixture append was refused");
      writeSessionEntry(owner, resolved.sessionKey, {
        sessionId: nextSessionId,
        updatedAt: updatedAt + 1,
      });
      executeSqliteQuerySync(
        owner.db,
        getSessionKysely(owner.db)
          .updateTable("session_windows")
          .set({ updated_at: updatedAt })
          .where("session_id", "=", sessionId),
      );
    }, toDatabaseOptions(resolved));
  }

  function database() {
    const target = resolveSqliteTargetFromSessionStorePath(readScope().storePath);
    return openOpenClawAgentDatabase({ agentId: target.agentId ?? "main", path: target.path });
  }

  return {
    createHistoricalTranscript,
    database,
    settlePhysicalUsage(): void {
      const owner = database();
      owner.walMaintenance.checkpoint();
      const freePages = Number(
        owner.db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0,
      );
      if (Number.isSafeInteger(freePages) && freePages > 0) {
        owner.db.exec(`PRAGMA incremental_vacuum(${freePages});`);
      }
      owner.walMaintenance.checkpoint();
    },
    setSessionUpdatedAt(sessionId: string, updatedAt: number): void {
      query((db) =>
        db
          .updateTable("session_windows")
          .set({ updated_at: updatedAt })
          .where("session_id", "=", sessionId),
      );
    },
    addRouteReference(sessionKey: string, sessionId: string): void {
      query((db) =>
        db.insertInto("session_nodes").values({
          session_key: sessionKey,
          current_session_id: sessionId,
          entry_json: "{}",
          updated_at: Date.now(),
        }),
      );
    },
    sessionExists(sessionId: string): boolean {
      return (
        query((db) =>
          db.selectFrom("session_windows").select("session_id").where("session_id", "=", sessionId),
        ).rows.length === 1
      );
    },
    readArchiveNames(sessionId: string): string[] {
      return fs
        .readdirSync(readScope().tempDir)
        .filter((name) => name.startsWith(`${sessionId}.jsonl.deleted.`));
    },
  };
}
