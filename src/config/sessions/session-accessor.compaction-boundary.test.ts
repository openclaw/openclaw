import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, describe, expect, it } from "vitest";
import { isRecordedModelFallbackStop } from "../../agents/model-fallback-stop.js";
import {
  withSessionCompactionPersistenceAsync,
  type CommittedCompactionAppend,
} from "../../agents/sessions/session-compaction-persistence.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { IncognitoSessionMissingError } from "../../state/incognito-session-error.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
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
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";

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
        // The independent retarget must not inherit the compaction's physical writer admission.
        await runInDetachedAsyncContext(() => manager.setSessionTargetAsync(replacement));
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
    expect(manager.getSessionTarget()).toMatchObject(replacement);
    expect(() => manager.getEntries()).toThrow("Session entry committed");
    expect(loadTranscriptEventsSync(scope).at(-1)).toMatchObject({
      id: receipt.result.id,
      type: "compaction",
    });
    expect(loadSessionEntry(scope)?.compactionCount).toBe(1);
    expect(loadTranscriptEventsSync(replacement)).toEqual([]);
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

  it("resolves after the boundary and accounting commit for incognito sessions", async () => {
    const dir = sessionDirs.make();
    const scope = {
      agentId: "main",
      sessionId: "session",
      sessionKey: "agent:main:dashboard:incognito-awaited-compaction",
      env: { OPENCLAW_STATE_DIR: dir },
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      compactionCount: 0,
      incognito: true,
    });
    const manager = await SessionManager.openAsync(scope, dir);
    const keptId = expectDefined(
      await manager.appendMessageAsync({ role: "user", content: "keep", timestamp: 1 }),
      "Compaction fixture must append its retained user entry",
    );
    const latch = { activeBytes: 2048, sessionId: scope.sessionId, maxBytes: 1024 };
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
    } finally {
      release.resolve();
      await pending.catch(() => {});
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
    const owner = { agentId: scope.agentId, path: resolveIncognitoOpenClawAgentSqlitePath(scope) };
    memorySessionActorOwners.closeDatabase(owner);
    const sql = observeMainThreadSql();
    try {
      await expect(
        persistCompactionBoundaryWithSessionEntryAsync(scope, {
          prepared: {
            scope,
            event: {
              type: "compaction",
              id: "closed-owner-compaction",
              parentId: entryId,
              timestamp: new Date(2).toISOString(),
              summary: "Closed owner",
              firstKeptEntryId: keptId,
              tokensBefore: 100,
            },
          },
          transcriptByteCompactionLatch: latch,
        }),
      ).rejects.toBeInstanceOf(IncognitoSessionMissingError);
      expect(memorySessionActorOwners.read(owner)).toBeUndefined();
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

describe("persistCompactionBoundaryWithSessionEntrySync", () => {
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
