import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import * as tmpDirOwner from "../../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import { loadTranscriptEventsSync, replaceSessionEntry } from "./session-accessor.js";
import { createSessionHistoryBudgetFixture } from "./session-history-budget.test-support.js";
import {
  enforceSqliteSessionHistoryDiskBudget,
  inspectSqliteSessionHistoryDiskBudget,
} from "./session-history-eviction.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

describe("SQLite historical session preservation", () => {
  let testState: OpenClawTestState;
  let tempDir: string;
  let storePath: string;
  const {
    createHistoricalTranscript,
    database,
    settlePhysicalUsage,
    sessionExists,
    readArchiveNames,
  } = createSessionHistoryBudgetFixture(() => ({ storePath, tempDir }));

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-session-history-preservation-",
      layout: "state-only",
    });
    vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(testState.root);
    tempDir = testState.sessionsDir();
    fs.mkdirSync(tempDir, { recursive: true });
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(async () => {
    resetAgentRunRegistryForTest();
    vi.restoreAllMocks();
    await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "warn",
      maintenance: { maxDiskBytes: null, highWaterBytes: null },
    });
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await testState.cleanup();
  });
  it.each([
    "recent",
    "archived",
    "pinned",
    "manual",
    "age-retention",
    "stale-dashboard",
    "restart-recovery",
  ] as const)(
    "preserves every generation of a %s session under physical pressure",
    async (protection) => {
      async function inspectHistoryReads<T>(operation: () => Promise<T>): Promise<T> {
        if (protection !== "recent") {
          return await operation();
        }
        const reads = trackSqliteStatementExecutions(database().db, ["history"], (sql) =>
          sql.startsWith("select") &&
          sql.includes('"session_windows"') &&
          sql.includes('"session_nodes"') &&
          sql.includes('"entry_json"')
            ? "history"
            : null,
        );
        try {
          const result = await operation();
          expect.soft(reads.rowCounts.history).toBeGreaterThan(0);
          expect.soft(reads.textBytes.history).toBeLessThan(16 * 1024);
          return result;
        } finally {
          reads.restore();
        }
      }
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const recentKey = "agent:main:recent-history";
      const staleKey = "agent:main:stale-history";
      await createHistoricalTranscript({
        content: "recent history " + "r".repeat(64 * 1024),
        nextSessionId: "recent-middle",
        sessionId: "recent-old",
        sessionKey: recentKey,
        updatedAt: now - 8 * dayMs,
      });
      await createHistoricalTranscript({
        content: "middle history",
        nextSessionId: "recent-live",
        sessionId: "recent-middle",
        sessionKey: recentKey,
        updatedAt: now - 8 * dayMs + 1,
      });
      await replaceSessionEntry(
        { sessionKey: recentKey, storePath },
        {
          sessionId: "recent-live",
          updatedAt: protection === "recent" ? now : now - 8 * dayMs,
          ...(protection === "recent"
            ? { skillsSnapshot: { prompt: "p".repeat(64 * 1024), skills: [] } }
            : {}),
          ...(protection !== "recent" && protection !== "pinned" ? { archivedAt: now } : {}),
          ...(protection !== "recent" && protection !== "pinned" && protection !== "archived"
            ? { archiveReason: protection }
            : {}),
          ...(protection === "pinned" ? { pinnedAt: now } : {}),
        },
      );
      await createHistoricalTranscript({
        content: "stale history " + "s".repeat(64 * 1024),
        nextSessionId: "stale-live",
        sessionId: "stale-old",
        sessionKey: staleKey,
        updatedAt: now - 8 * dayMs,
      });
      settlePhysicalUsage();
      const before = await measureSessionPhysicalDiskUsage(storePath);

      const result = await inspectHistoryReads(() =>
        enforceSqliteSessionHistoryDiskBudget({
          storePath,
          mode: "enforce",
          maintenance: {
            maxDiskBytes: before.totalBytes - 1,
            highWaterBytes: 0,
            preserveRecentMs: protection === "recent" ? 7 * dayMs : undefined,
          },
        }),
      );

      expect(result?.removedEntries).toBe(1);
      expect(sessionExists("recent-old")).toBe(true);
      expect(sessionExists("recent-middle")).toBe(true);
      expect(sessionExists("recent-live")).toBe(true);
      expect(sessionExists("stale-old")).toBe(false);
      expect(sessionExists("stale-live")).toBe(true);
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      const repeated = {
        storePath,
        mode: "enforce" as const,
        maintenance: {
          maxDiskBytes: 1,
          highWaterBytes: 1,
          preserveRecentMs: protection === "recent" ? 7 * dayMs : undefined,
        },
      };
      expect(
        await inspectHistoryReads(() => inspectSqliteSessionHistoryDiskBudget(repeated)),
      ).toMatchObject({
        wouldMutate: false,
      });
      expect(
        await inspectHistoryReads(() => enforceSqliteSessionHistoryDiskBudget(repeated)),
      ).toMatchObject({
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
      await createHistoricalTranscript({
        content: "retained history",
        nextSessionId: "raw-live",
        sessionId: "raw-old",
        sessionKey,
        updatedAt: now,
      });
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
      const input = {
        storePath,
        mode: "enforce" as const,
        maintenance: {
          maxDiskBytes: 1,
          highWaterBytes: 1,
          preserveRecentMs: 7 * 24 * 60 * 60 * 1000,
        },
      };
      expect(await inspectSqliteSessionHistoryDiskBudget(input)).toMatchObject({
        wouldMutate: false,
      });
      expect(await enforceSqliteSessionHistoryDiskBudget(input)).toMatchObject({
        removedEntries: 0,
      });
      expect(sessionExists("raw-old")).toBe(true);
      expect(sessionExists("raw-live")).toBe(true);
      expect(loadTranscriptEventsSync({ sessionId: "raw-old", sessionKey, storePath })).not.toEqual(
        [],
      );
      expect(readArchiveNames("raw-old")).toEqual([]);
      expect(readBytes()).toEqual(expectedBytes);
    },
  );
});
