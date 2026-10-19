import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import { loadTranscriptEventsSync, replaceSessionEntry } from "./session-accessor.js";
import { installHistoryBudgetState } from "./session-history-budget-state.test-support.js";
import { createSessionHistoryBudgetFixture } from "./session-history-budget.test-support.js";
import {
  enforceSqliteSessionHistoryDiskBudget as enforce,
  inspectSqliteSessionHistoryDiskBudget as inspect,
} from "./session-history-eviction.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

describe("SQLite historical session preservation", () => {
  let tempDir: string;
  let storePath: string;
  const {
    createHistoricalTranscript,
    database,
    settlePhysicalUsage,
    sessionExists,
    readArchiveNames,
  } = createSessionHistoryBudgetFixture(() => ({ storePath, tempDir }));

  installHistoryBudgetState("openclaw-session-history-preservation-", (_state, dir, store) => {
    tempDir = dir;
    storePath = store;
  });
  const dayMs = 24 * 60 * 60 * 1000;
  const history = (
    sessionId: string,
    nextSessionId: string,
    sessionKey: string,
    updatedAt: number,
    content = "history",
  ) => createHistoricalTranscript({ sessionId, nextSessionId, sessionKey, updatedAt, content });
  const input = (preserveRecentMs?: number, maxDiskBytes = 1, highWaterBytes = 1) => ({
    storePath,
    mode: "enforce" as const,
    maintenance: { maxDiskBytes, highWaterBytes, preserveRecentMs },
  });
  it.each(["registry", "recent", "pinned", "manual"] as const)(
    "preserves every generation of a %s session under physical pressure",
    async (protection) => {
      async function inspectHistoryReads<T>(operation: () => Promise<T>): Promise<T> {
        if (protection !== "recent") {
          return await operation();
        }
        const reads = trackSqliteStatementExecutions(
          requireNativeSqliteDatabase(database().db),
          ["history"],
          (sql) =>
            sql.startsWith("select") &&
            sql.includes('"session_windows"') &&
            sql.includes('"session_nodes"') &&
            sql.includes('"entry_json"') &&
            !sql.includes('where "session_windows"."session_id" =')
              ? "history"
              : null,
        );
        try {
          const result = await operation();
          // Whole-store recent-history discovery belongs to the worker; keyed live checks remain.
          expect.soft([reads.rowCounts.history, reads.textBytes.history]).toEqual([0, 0]);
          return result;
        } finally {
          reads.restore();
        }
      }
      const now = Date.now();
      const staleAt = now - 8 * dayMs;
      const recentKey = "agent:main:recent-history";
      const staleKey = "agent:main:stale-history";
      await history("recent-old", "recent-middle", recentKey, staleAt, "r".repeat(64 * 1024));
      await history("recent-middle", "recent-live", recentKey, staleAt + 1);
      await replaceSessionEntry(
        { sessionKey: recentKey, storePath },
        {
          sessionId: "recent-live",
          updatedAt: protection === "recent" ? now : staleAt,
          ...(protection === "recent"
            ? { skillsSnapshot: { prompt: "p".repeat(64 * 1024), skills: [] } }
            : {}),
          ...(protection === "manual" ? { archivedAt: now, archiveReason: protection } : {}),
          ...(protection === "registry"
            ? { archivedAt: now, archiveReason: "active-session-cap" as const }
            : {}),
          ...(protection === "pinned" ? { pinnedAt: now } : {}),
        },
      );
      await history("stale-old", "stale-live", staleKey, staleAt, "s".repeat(64 * 1024));
      settlePhysicalUsage();
      if (protection === "registry") {
        registerAgentRunContext("history-live-run", {
          agentId: "main",
          sessionKey: recentKey,
          projectSessionActive: true,
        });
      }
      const before = await measureSessionPhysicalDiskUsage(storePath);
      const preserveRecentMs = protection === "recent" ? 7 * dayMs : undefined;
      const result = await inspectHistoryReads(() =>
        enforce(input(preserveRecentMs, before.totalBytes - 1, 0)),
      );

      expect(result?.removedEntries).toBe(1);
      expect(
        ["recent-old", "recent-middle", "recent-live", "stale-old", "stale-live"].map(
          sessionExists,
        ),
      ).toEqual([true, true, true, false, true]);
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      const repeated = input(preserveRecentMs);
      expect(await inspectHistoryReads(() => inspect(repeated))).toMatchObject({
        wouldMutate: false,
      });
      expect(await inspectHistoryReads(() => enforce(repeated))).toMatchObject({
        removedEntries: 0,
      });
      for (const sessionId of ["recent-old", "recent-middle"]) {
        expect(
          loadTranscriptEventsSync({ sessionId, sessionKey: recentKey, storePath }),
        ).not.toEqual([]);
        expect(readArchiveNames(sessionId)).toEqual([]);
      }
    },
  );

  it.each(["UTF-16le", "UTF-16be"] as const)(
    "preserves raw identity bytes during recent-history preview and enforcement in %s",
    async (encoding) => {
      const target = resolveSqliteTargetFromSessionStorePath(storePath);
      fs.mkdirSync(path.dirname(target.path), { recursive: true });
      const seed = new DatabaseSync(target.path);
      try {
        seed.exec(
          `PRAGMA encoding='${encoding}'; CREATE TABLE encoding_probe(value TEXT); DROP TABLE encoding_probe;`,
        );
      } finally {
        seed.close();
      }
      const sessionKey = "agent:main:raw-identity-history";
      const now = Date.now();
      await history("raw-old", "raw-live", sessionKey, now);
      const owner = database();
      const encode = (value: string) => {
        const bytes = Buffer.from(value, "utf16le");
        return encoding === "UTF-16be" ? bytes.swap16() : bytes;
      };
      const identity = encode("\ufffe\uffff");
      const entry = encode(
        JSON.stringify({
          sessionId: "\ufffe\uffff",
          updatedAt: now,
          skillsSnapshot: { prompt: "p".repeat(64 * 1024), skills: [] },
        }),
      );
      // CAST preserves the raw stored identity; normal TEXT rebinding can normalize it.
      owner.db
        .prepare(
          "UPDATE session_nodes SET current_session_id = CAST(? AS TEXT), entry_json = CAST(? AS TEXT), updated_at = ? WHERE session_key = ?",
        )
        .run(identity, entry, now, sessionKey);
      owner.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(sessionKey);
      const readBytes = () =>
        database()
          .db.prepare(
            "SELECT hex(current_session_id) AS identity, hex(entry_json) AS entry FROM session_nodes WHERE session_key = ?",
          )
          .get(sessionKey);
      const expectedBytes = {
        identity: identity.toString("hex").toUpperCase(),
        entry: entry.toString("hex").toUpperCase(),
      };
      expect(readBytes()).toEqual(expectedBytes);
      settlePhysicalUsage();
      const preserved = input(7 * dayMs);
      expect(await inspect(preserved)).toMatchObject({ wouldMutate: false });
      expect(await enforce(preserved)).toMatchObject({ removedEntries: 0 });
      expect(["raw-old", "raw-live"].map(sessionExists)).toEqual([true, true]);
      expect(loadTranscriptEventsSync({ sessionId: "raw-old", sessionKey, storePath })).not.toEqual(
        [],
      );
      expect(readArchiveNames("raw-old")).toEqual([]);
      expect(readBytes()).toEqual(expectedBytes);
    },
  );
});
