import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withSessionCompactionPersistence } from "../../agents/sessions/session-compaction-persistence.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  persistCompactionBoundaryWithSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("persistCompactionBoundaryWithSessionEntrySync", () => {
  it.each([false, true])(
    "publishes the boundary, count, and byte latch in one commit (incognito=%s)",
    async (incognito) => {
      const dir = tempDirs.make("openclaw-compaction-boundary-");
      const scope = {
        agentId: "main",
        sessionId: "session",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-compaction-boundary"
          : "agent:main:compaction-boundary",
        env: { OPENCLAW_STATE_DIR: dir },
        storePath: path.join(dir, "sessions.json"),
      };
      const expected = {
        sessionId: scope.sessionId,
        lifecycleRevision: "lifecycle",
        activeWriterRunId: "writer",
      };
      await upsertSessionEntryCore(scope, {
        ...expected,
        compactionCount: 0,
        updatedAt: 1,
      });
      const manager = SessionManager.open(scope, dir);
      const keptId = manager.appendMessage({ role: "user", content: "keep", timestamp: 1 });
      const before = loadTranscriptEventsSync(scope);

      let reads: ReturnType<typeof trackSqliteStatementExecutions> | undefined;
      let entryRows = 0;
      let entryId: string;
      try {
        entryId = withSessionCompactionPersistence(
          manager,
          {
            prepare: () => {
              const database = openOpenClawAgentDatabase(
                toDatabaseOptions(resolveSqliteTranscriptScope(scope)),
              );
              reads = trackSqliteStatementExecutions(database.db, ["entry"], (sql) =>
                sql.startsWith('select * from "session_nodes" where "session_key" = ?')
                  ? "entry"
                  : null,
              );
              return {
                scope: {
                  ...scope,
                  expectedLifecycleRevision: expected.lifecycleRevision,
                  expectedWriterRunId: expected.activeWriterRunId,
                },
                transcriptByteCompactionLatch: {
                  activeBytes: 2048,
                  sessionId: scope.sessionId,
                  maxBytes: 1024,
                },
              };
            },
            assertActive: () => {},
            onCommitted: () => {
              entryRows = reads?.rowCounts.entry ?? 0;
              reads?.restore();
            },
          },
          () => manager.appendCompaction("summary", keptId, 100),
        );
      } finally {
        reads?.restore();
      }

      expect(loadTranscriptEventsSync(scope)).toEqual([
        ...before,
        expect.objectContaining({ id: entryId, type: "compaction" }),
      ]);
      expect(loadSessionEntry(scope)).toMatchObject({
        compactionCount: 1,
        transcriptByteCompactionLatch: {
          activeBytes: 2048,
          sessionId: scope.sessionId,
          maxBytes: 1024,
        },
      });
      // Keep authority and post-append reads; accounting reuses its freshly decoded entry.
      expect(entryRows).toBeGreaterThan(0);
      expect(entryRows).toBeLessThanOrEqual(3);
    },
  );

  it("rolls back accounting when the prepared boundary identity already exists", async () => {
    const dir = tempDirs.make("openclaw-compaction-boundary-rollback-");
    const scope = {
      agentId: "main",
      sessionId: "session",
      sessionKey: "agent:main:compaction-boundary-rollback",
      storePath: path.join(dir, "sessions.json"),
    };
    const expected = {
      sessionId: scope.sessionId,
      lifecycleRevision: "lifecycle",
      activeWriterRunId: "writer",
    };
    await upsertSessionEntryCore(scope, {
      ...expected,
      compactionCount: 0,
      updatedAt: 1,
    });
    const manager = SessionManager.open(scope, dir);
    const keptId = manager.appendMessage({ role: "user", content: "keep", timestamp: 1 });
    const before = loadTranscriptEventsSync(scope);

    expect(() =>
      persistCompactionBoundaryWithSessionEntrySync(
        {
          ...scope,
          expectedLifecycleRevision: expected.lifecycleRevision,
          expectedWriterRunId: expected.activeWriterRunId,
        },
        {
          prepared: {
            scope,
            event: {
              type: "compaction",
              id: keptId,
              parentId: keptId,
              timestamp: new Date(1).toISOString(),
              summary: "summary",
              firstKeptEntryId: keptId,
              tokensBefore: 100,
            },
          },
          transcriptByteCompactionLatch: {
            activeBytes: 2048,
            sessionId: scope.sessionId,
            maxBytes: 1024,
          },
        },
      ),
    ).toThrow(
      `Session transcript entry was not persisted: ${keptId}: transcript-event-not-appended`,
    );

    expect(loadTranscriptEventsSync(scope)).toEqual(before);
    expect(loadSessionEntry(scope)).toMatchObject({ compactionCount: 0 });
    expect(loadSessionEntry(scope)?.transcriptByteCompactionLatch).toBeUndefined();
  });

  it("rolls back when the admitted writer rejects the appended boundary", async () => {
    const dir = tempDirs.make("openclaw-compaction-boundary-owner-");
    const scope = {
      agentId: "main",
      sessionId: "session",
      sessionKey: "agent:main:compaction-boundary-owner",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      compactionCount: 0,
      updatedAt: 1,
    });
    const manager = SessionManager.open(scope, dir);
    const keptId = manager.appendMessage({ role: "user", content: "keep", timestamp: 1 });
    const before = loadTranscriptEventsSync(scope);
    const ownerClosed = new Error("compaction owner closed");

    await expect(
      withOwnedSessionTranscriptWrites(
        {
          sessionTarget: scope,
          assertCommitAllowed: () => {
            if (loadTranscriptEventsSync(scope).length > before.length) {
              throw ownerClosed;
            }
          },
          withTranscriptWrite: async (run) => await run(),
        },
        async () =>
          persistCompactionBoundaryWithSessionEntrySync(scope, {
            prepared: {
              scope,
              event: {
                type: "compaction",
                id: "prepared-compaction",
                parentId: keptId,
                timestamp: new Date(1).toISOString(),
                summary: "summary",
                firstKeptEntryId: keptId,
                tokensBefore: 100,
              },
            },
            transcriptByteCompactionLatch: {
              activeBytes: 2048,
              sessionId: scope.sessionId,
              maxBytes: 1024,
            },
          }),
      ),
    ).rejects.toBe(ownerClosed);

    expect(loadTranscriptEventsSync(scope)).toEqual(before);
    expect(loadSessionEntry(scope)).toMatchObject({ compactionCount: 0 });
    expect(loadSessionEntry(scope)?.transcriptByteCompactionLatch).toBeUndefined();
  });
});
