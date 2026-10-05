import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  isSessionNodePayloadSelect,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { isRecordedModelFallbackStop } from "../../agents/model-fallback-stop.js";
import {
  withSessionCompactionPersistence,
  withSessionCompactionPersistenceAsync,
  type CompactionAppendPersistenceAsync,
  type CommittedCompactionAppend,
} from "../../agents/sessions/session-compaction-persistence.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  persistCompactionBoundaryWithSessionEntrySync,
  persistCompactionBoundaryWithSessionEntryAsync,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  runWithoutOwnedSessionTranscriptWrites,
  withOwnedSessionTranscriptWrites,
} from "./transcript-write-context.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-compaction-boundary-");

describe("awaited compaction persistence", () => {
  it("retains a committed receipt when accounting retargets the manager before publication", async () => {
    const dir = sessionDirs.make();
    const scope = {
      agentId: "main",
      sessionId: "source",
      sessionKey: "agent:main:compaction-retarget-source",
      env: { OPENCLAW_STATE_DIR: dir },
      storePath: path.join(dir, "sessions.json"),
    };
    const replacement = {
      ...scope,
      sessionId: "replacement",
      sessionKey: "agent:main:compaction-retarget-next",
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      compactionCount: 0,
    });
    await upsertSessionEntryCore(replacement, { sessionId: replacement.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(scope, dir);
    const keptId = expectDefined(
      await manager.appendMessageAsync({ role: "user", content: "keep", timestamp: 1 }),
      "Compaction fixture must append its retained user entry",
    );
    let committed: CommittedCompactionAppend | undefined;
    const pending = withSessionCompactionPersistenceAsync(
      manager,
      async (prepared) => {
        committed = await persistCompactionBoundaryWithSessionEntryAsync(scope, {
          prepared,
          transcriptByteCompactionLatch: {
            activeBytes: 2048,
            sessionId: scope.sessionId,
            maxBytes: 1024,
          },
        });
        // A separate retarget operation does not inherit the compaction writer's authority.
        await runWithoutOwnedSessionTranscriptWrites(() =>
          manager.setSessionTargetAsync(replacement),
        );
        return committed;
      },
      () => manager.appendCompactionAsync("summary", keptId, 100),
    );
    const failure: unknown = await pending.catch((error: unknown) => error);
    const receipt = expectDefined(committed, "Compaction must commit before retargeting");
    expect(failure).toMatchObject({
      name: "SessionEntryCommittedError",
      committedEntryId: receipt.result.id,
      committedTarget: expect.objectContaining(scope),
      committedVersion: receipt.after,
    });
    expect(isRecordedModelFallbackStop(failure)).toBe(true);
    expect(() => manager.getEntries()).toThrow("Session entry committed");
    expect(loadTranscriptEventsSync(scope).at(-1)).toMatchObject({
      id: receipt.result.id,
      type: "compaction",
    });
    expect(loadSessionEntry(scope)?.compactionCount).toBe(1);
    expect(loadTranscriptEventsSync(replacement)).toEqual([]);
  });

  it("rejects a detached manager's accounting hook without appending a boundary", async () => {
    const manager = SessionManager.inMemory();
    const keptId = expectDefined(
      await manager.appendMessageAsync({ role: "user", content: "keep", timestamp: 1 }),
      "Compaction fixture must append its retained user entry",
    );
    const before = manager.getEntries();
    const persist = vi.fn<CompactionAppendPersistenceAsync>();
    await expect(
      withSessionCompactionPersistenceAsync(manager, persist, () =>
        manager.appendCompactionAsync("summary", keptId, 100),
      ),
    ).rejects.toThrow("Compaction boundary validation failed");
    expect(persist).not.toHaveBeenCalled();
    expect(manager.getEntries()).toEqual(before);
    expect(manager.getLeafId()).toBe(keptId);
  });

  it.each(["ambient", "explicit"] as const)(
    "refuses a writer acquired while an owner-less compaction waits for admission (%s)",
    async (binding) => {
      const dir = sessionDirs.make();
      const scope = {
        agentId: "main",
        sessionId: "session",
        sessionKey: "agent:main:awaited-compaction-owner",
        env: { OPENCLAW_STATE_DIR: dir },
        storePath: path.join(dir, "sessions.json"),
      };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        compactionCount: 0,
      });
      const manager = await SessionManager.openAsync(scope, dir);
      const keptId = expectDefined(
        await manager.appendMessageAsync({ role: "user", content: "keep", timestamp: 1 }),
        "Compaction fixture must append its retained user entry",
      );
      const original = loadSessionEntry(scope)!;
      expect(original.activeWriterRunId).toBeUndefined();
      const expectedOwner = {
        lifecycleRevision: original.lifecycleRevision,
        activeWriterRunId: original.activeWriterRunId,
      };
      const fencedScope = { ...scope, expectedOwner };
      const before = loadTranscriptEventsSync(scope);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const held = runOpenClawAgentWriteAdmission(
        toDatabaseOptions(resolveSqliteTranscriptScope(scope)),
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await entered.promise;
      try {
        const pending =
          binding === "ambient"
            ? withOwnedSessionTranscriptWrites(
                {
                  sessionTarget: fencedScope,
                  assertCommitAllowed: () => {},
                  withTranscriptWrite: async (run) => await run(),
                },
                () =>
                  withSessionCompactionPersistenceAsync(
                    manager,
                    (prepared) =>
                      persistCompactionBoundaryWithSessionEntryAsync(scope, {
                        prepared,
                        transcriptByteCompactionLatch: {
                          activeBytes: 2048,
                          sessionId: scope.sessionId,
                          maxBytes: 1024,
                        },
                      }),
                    () => manager.appendCompactionAsync("summary", keptId, 100),
                  ),
              )
            : persistCompactionBoundaryWithSessionEntryAsync(fencedScope, {
                prepared: {
                  scope: fencedScope,
                  event: {
                    type: "compaction",
                    id: "queued-compaction",
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
              });
        const rejected = expect(pending).rejects.toThrow("session writer claim changed");
        // A direct writer can commit while the process-local asynchronous lane waits.
        replaceSessionEntrySync(scope, { ...original, activeWriterRunId: "replacement-writer" });
        expectedOwner.activeWriterRunId = "replacement-writer";
        release.resolve();
        await held;
        await rejected;
      } finally {
        release.resolve();
        await held;
      }
      expect(loadTranscriptEventsSync(scope)).toEqual(before);
      expect(loadSessionEntry(scope)).toMatchObject({
        compactionCount: 0,
        activeWriterRunId: "replacement-writer",
      });
    },
  );

  it.each([false, true])(
    "resolves after the boundary and accounting commit (incognito=%s)",
    async (incognito) => {
      const dir = sessionDirs.make();
      const scope = {
        agentId: "main",
        sessionId: "session",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-awaited-compaction"
          : "agent:main:awaited-compaction",
        env: { OPENCLAW_STATE_DIR: dir },
        storePath: path.join(dir, "sessions.json"),
      };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        compactionCount: 0,
        ...(incognito ? { incognito: true as const } : {}),
      });
      const manager = await SessionManager.openAsync(scope, dir);
      const keptId = expectDefined(
        await manager.appendMessageAsync({ role: "user", content: "keep", timestamp: 1 }),
        "Compaction fixture must append its retained user entry",
      );
      const latch = { activeBytes: 2048, sessionId: scope.sessionId, maxBytes: 1024 };
      const database = openOpenClawAgentDatabase(
        toDatabaseOptions(resolveSqliteTranscriptScope(scope)),
      );
      const reads = trackSqliteStatementExecutions(database.db, ["entry"], (sql) =>
        isSessionNodePayloadSelect(sql) ? "entry" : null,
      );
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const pending = withSessionCompactionPersistenceAsync(
        manager,
        async (prepared) => {
          entered.resolve();
          await release.promise;
          return await persistCompactionBoundaryWithSessionEntryAsync(scope, {
            prepared,
            transcriptByteCompactionLatch: latch,
          });
        },
        () => manager.appendCompactionAsync("summary", keptId, 100),
      );
      let entryId: string;
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Compaction returned before awaiting its accounting hook");
          }),
        ]);
        expect(manager.getLeafId()).toBe(keptId);
        expect(manager.getBoundaryCount()).toBe(0);
        release.resolve();
        entryId = await pending;
        if (!incognito) {
          expect(reads.rowCounts.entry).toBe(0);
        }
      } finally {
        release.resolve();
        await pending.catch(() => {});
        reads.restore();
      }
      expect(manager.getEntry(entryId)).toMatchObject({
        id: entryId,
        type: "compaction",
        parentId: keptId,
      });
      expect(loadTranscriptEventsSync(scope).at(-1)).toMatchObject({
        id: entryId,
        type: "compaction",
      });
      expect(loadSessionEntry(scope)).toMatchObject({
        compactionCount: 1,
        transcriptByteCompactionLatch: latch,
      });

      await expect(
        persistCompactionBoundaryWithSessionEntryAsync(scope, {
          prepared: {
            scope,
            event: {
              type: "compaction",
              id: entryId,
              parentId: keptId,
              timestamp: new Date(1).toISOString(),
              summary: "duplicate",
              firstKeptEntryId: keptId,
              tokensBefore: 100,
            },
          },
          transcriptByteCompactionLatch: { ...latch, activeBytes: 4096 },
        }),
      ).rejects.toThrow(`Session transcript entry was not persisted: ${entryId}`);
      expect(loadSessionEntry(scope)).toMatchObject({
        compactionCount: 1,
        transcriptByteCompactionLatch: latch,
      });
    },
  );
});

describe("persistCompactionBoundaryWithSessionEntrySync", () => {
  it.each([false, true])(
    "publishes the boundary, count, and byte latch in one commit (incognito=%s)",
    async (incognito) => {
      const dir = sessionDirs.make();
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
      const manager = await SessionManager.openAsync(scope, dir);
      const keptId = expectDefined(
        await manager.appendMessageAsync({ role: "user", content: "keep", timestamp: 1 }),
        "Compaction fixture must append its retained user entry",
      );
      const before = loadTranscriptEventsSync(scope);

      let entryRows = 0;
      const entryId = withSessionCompactionPersistence(
        manager,
        (prepared) => {
          const database = openOpenClawAgentDatabase(
            toDatabaseOptions(resolveSqliteTranscriptScope(scope)),
          );
          const reads = trackSqliteStatementExecutions(database.db, ["entry"], (sql) =>
            isSessionNodePayloadSelect(sql) && sql.includes('where "session_key" = ?')
              ? "entry"
              : null,
          );
          try {
            return persistCompactionBoundaryWithSessionEntrySync(
              {
                ...scope,
                expectedLifecycleRevision: expected.lifecycleRevision,
                expectedWriterRunId: expected.activeWriterRunId,
              },
              {
                prepared,
                transcriptByteCompactionLatch: {
                  activeBytes: 2048,
                  sessionId: scope.sessionId,
                  maxBytes: 1024,
                },
              },
            );
          } finally {
            entryRows = reads.rowCounts.entry;
            reads.restore();
          }
        },
        () => manager.appendCompaction("summary", keptId, 100),
      );

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
    const dir = sessionDirs.make();
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
    const manager = await SessionManager.openAsync(scope, dir);
    const keptId = expectDefined(
      await manager.appendMessageAsync({ role: "user", content: "keep", timestamp: 1 }),
      "Compaction fixture must append its retained user entry",
    );
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
    const dir = sessionDirs.make();
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
    const manager = await SessionManager.openAsync(scope, dir);
    const keptId = expectDefined(
      await manager.appendMessageAsync({ role: "user", content: "keep", timestamp: 1 }),
      "Compaction fixture must append its retained user entry",
    );
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
