import fs from "node:fs";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

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
    await replaceSessionEntry(
      { sessionKey: params.sessionKey, storePath: readScope().storePath },
      { sessionId: params.sessionId, updatedAt: params.updatedAt },
    );
    await appendTranscriptMessage(
      {
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath: readScope().storePath,
      },
      { message: { role: "user", content: params.content } },
    );
    await resetSessionEntryLifecycle({
      storePath: readScope().storePath,
      target: { canonicalKey: params.sessionKey, storeKeys: [params.sessionKey] },
      buildNextEntry: () => ({ sessionId: params.nextSessionId, updatedAt: params.updatedAt + 1 }),
    });
    setSessionUpdatedAt(params.sessionId, params.updatedAt);
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
