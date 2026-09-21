import assert from "node:assert/strict";
import fs from "node:fs";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
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
      return;
    }
    const next = pending.slice(joined);
    joined = pending.length;
    work.push(...next);
    await Promise.all(next);
    // A settled sweep may enqueue its existing pending-force continuation.
    // A single queue barrier can return before that follow-up pass completes.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

export function createSessionHistoryBudgetFixture(
  readScope: () => { storePath: string; tempDir: string },
) {
  async function createHistoricalTranscript(params: {
    content: string;
    nextSessionId: string;
    sessionId: string;
    sessionKey: string;
    updatedAt: number;
  }): Promise<void> {
    const resolved = resolveSqliteTranscriptScope({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: readScope().storePath,
    });
    // Seed through the canonical writers without lifecycle publication or maintenance kicks.
    runOpenClawAgentWriteTransaction((owner) => {
      writeSessionEntry(owner, resolved.sessionKey, {
        sessionId: params.sessionId,
        updatedAt: params.updatedAt,
      });
      const appended = appendTranscriptMessageInTransaction(owner, resolved, {
        message: { role: "user", content: params.content },
      });
      assert(appended?.appended, "Historical transcript fixture append was refused");
      writeSessionEntry(owner, resolved.sessionKey, {
        sessionId: params.nextSessionId,
        updatedAt: params.updatedAt + 1,
      });
      executeSqliteQuerySync(
        owner.db,
        getSessionKysely(owner.db)
          .updateTable("session_windows")
          .set({ updated_at: params.updatedAt })
          .where("session_id", "=", params.sessionId),
      );
    }, toDatabaseOptions(resolved));
  }

  function database() {
    const target = resolveSqliteTargetFromSessionStorePath(readScope().storePath);
    if (!target.path) {
      throw new Error("expected SQLite database path");
    }
    return openOpenClawAgentDatabase({ agentId: target.agentId ?? "main", path: target.path });
  }

  function settlePhysicalUsage(): void {
    const owner = database();
    owner.walMaintenance.checkpoint();
    const row = owner.db.prepare("PRAGMA freelist_count").get() as
      | { freelist_count?: unknown }
      | undefined;
    const freePages = Number(row?.freelist_count ?? 0);
    if (Number.isSafeInteger(freePages) && freePages > 0) {
      owner.db.exec(`PRAGMA incremental_vacuum(${freePages});`);
    }
    owner.walMaintenance.checkpoint();
  }

  function setSessionUpdatedAt(sessionId: string, updatedAt: number): void {
    const owner = database();
    executeSqliteQuerySync(
      owner.db,
      getSessionKysely(owner.db)
        .updateTable("session_windows")
        .set({ updated_at: updatedAt })
        .where("session_id", "=", sessionId),
    );
  }

  function addRouteReference(sessionKey: string, sessionId: string): void {
    const owner = database();
    const db = getSessionKysely(owner.db);
    executeSqliteQuerySync(
      owner.db,
      db.insertInto("session_nodes").values({
        session_key: sessionKey,
        current_session_id: sessionId,
        entry_json: "{}",
        updated_at: Date.now(),
      }),
    );
  }

  function sessionExists(sessionId: string): boolean {
    const owner = database();
    const db = getSessionKysely(owner.db);
    return (
      executeSqliteQuerySync(
        owner.db,
        db.selectFrom("session_windows").select("session_id").where("session_id", "=", sessionId),
      ).rows.length === 1
    );
  }

  function readArchiveNames(sessionId: string): string[] {
    return fs
      .readdirSync(readScope().tempDir)
      .filter((name) => name.startsWith(`${sessionId}.jsonl.deleted.`));
  }
  return {
    createHistoricalTranscript,
    database,
    settlePhysicalUsage,
    setSessionUpdatedAt,
    addRouteReference,
    sessionExists,
    readArchiveNames,
  };
}
