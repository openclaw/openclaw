import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, expect, it, vi } from "vitest";
import { isRecordedModelFallbackStop } from "../../agents/model-fallback-stop.js";
import {
  withSessionCompactionPersistenceAsync,
  type CommittedCompactionBoundary,
  type PreparedCompactionAppend,
  type CompactionAppendPersistenceAsync,
} from "../../agents/sessions/session-compaction-persistence.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { IncognitoSessionMissingError } from "../../state/incognito-session-error.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { openOpenClawAgentSqliteWorkerStoreV2 } from "../../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { sessionNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  persistCompactionBoundaryWithSessionEntrySync,
  persistCompactionBoundaryWithSessionEntryAsync,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { applySessionEntryOperation } from "./session-accessor.sqlite-entry.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import type { SessionMetadataWorkerOperations } from "./session-manager-write-contract.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";
import type { SessionEntry } from "./types.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-compaction-boundary-");

function sessionScope(key: string, sessionId = "session", withEnv = true) {
  const dir = sessionDirs.make();
  return {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${key}`,
    ...(withEnv ? { env: { OPENCLAW_STATE_DIR: dir } } : {}),
    storePath: path.join(dir, "sessions.json"),
  };
}

async function seedCompaction(
  scope: ReturnType<typeof sessionScope>,
  entry: Partial<SessionEntry> = {},
) {
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    compactionCount: 0,
    ...entry,
  });
  const manager = await SessionManager.openAsync(scope, path.dirname(scope.storePath));
  const keptId = expectDefined(
    await manager.appendMessageAsync({ role: "user", content: "keep", timestamp: 1 }),
    "Compaction fixture must append its retained user entry",
  );
  const persist: CompactionAppendPersistenceAsync = (prepared) =>
    persistCompactionBoundaryWithSessionEntryAsync(scope, {
      prepared,
      transcriptByteCompactionLatch: byteLatch(scope),
    });
  const compact = (save = persist) =>
    withSessionCompactionPersistenceAsync(manager, save, () =>
      manager.appendCompactionAsync("summary", keptId, 100),
    );
  return { manager, keptId, persist, compact };
}

type CompactionScope = Parameters<typeof persistCompactionBoundaryWithSessionEntrySync>[0];
const byteLatch = (scope: CompactionScope) => ({
  activeBytes: 2048,
  sessionId: scope.sessionId,
  maxBytes: 1024,
});
function preparedBoundary(
  scope: CompactionScope,
  keptId: string,
  id: string,
  overrides: Partial<PreparedCompactionAppend["event"]> = {},
) {
  return {
    scope,
    event: {
      type: "compaction" as const,
      id,
      parentId: keptId,
      timestamp: new Date(1).toISOString(),
      summary: "summary",
      firstKeptEntryId: keptId,
      tokensBefore: 100,
      ...overrides,
    },
  };
}
function expectRolledBack(
  scope: CompactionScope,
  before: ReturnType<typeof loadTranscriptEventsSync>,
) {
  expect(loadTranscriptEventsSync(scope)).toEqual(before);
  expect(loadSessionEntry(scope)).toMatchObject({ compactionCount: 0 });
  expect(loadSessionEntry(scope)?.transcriptByteCompactionLatch).toBeUndefined();
}

it.each([false, true])(
  "fuses summary accounting and intervening metadata (incognito=%s)",
  async (incognito) => {
    const scope = sessionScope(
      incognito ? "dashboard:incognito-successive-compactions" : "successive-compactions",
      "successive-compactions",
    );
    const { manager, compact } = await seedCompaction(scope, incognito ? { incognito: true } : {});
    await compact();
    await upsertSessionEntryCore(scope, {
      ...loadSessionEntry(scope)!,
      compactionCount: 7,
      label: "preserve this metadata",
    });
    let committed: CommittedCompactionBoundary | undefined;
    const boundaryId = await compact(async (prepared) => {
      committed = await persistCompactionBoundaryWithSessionEntryAsync(scope, {
        prepared,
        tokensAfter: 45,
        transcriptByteCompactionLatch: null,
      });
      return committed;
    });
    const receipt = expectDefined(committed, "Compaction must return its committed accounting");
    expect(receipt.entry).toMatchObject({
      compactionCount: 8,
      label: "preserve this metadata",
      totalTokens: 45,
      totalTokensFresh: true,
    });
    expect(receipt.entry.transcriptByteCompactionLatch).toBeUndefined();
    expect(loadSessionEntry(scope)).toEqual(receipt.entry);

    // A recap without a final estimate must invalidate the provisional tokens without recounting.
    const corrected = await applySessionEntryOperation(
      scope,
      { kind: "compaction-accounting", accounting: { amount: 0, tokensAfter: null } },
      { skipMaintenance: true },
    );
    expect(corrected).toMatchObject({ compactionCount: 8, totalTokensFresh: false });
    expect(corrected?.totalTokensVersion).toBeUndefined();
    const nextId = await manager.appendMessageAsync({
      role: "user",
      content: "next",
      timestamp: 2,
    });
    expect(loadSessionEntry(scope)).toMatchObject({
      compactionCount: 8,
      label: "preserve this metadata",
    });
    expect((await loadTranscriptEvents(scope)).slice(-2)).toMatchObject([
      { id: boundaryId, type: "compaction" },
      { id: nextId, type: "message", parentId: boundaryId },
    ]);
    expect((await SessionManager.openAsync(scope)).getBranch()).toEqual(manager.getBranch());
  },
);

it("rolls back the boundary and accounting when live authority is revoked at commit", async () => {
  const scope = sessionScope("compaction-authority-at-commit");
  const { compact } = await seedCompaction(scope);
  const before = loadTranscriptEventsSync(scope);
  let current = true;
  let revoked = false;
  const ownerClosed = new Error("compaction authority revoked");
  const create = admission.createSqliteWorkerOperationAdmission;
  const observed = vi
    .spyOn(admission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((callback, attachment) =>
      create((request, grant) => {
        if (
          request.stage === "commit" &&
          isRecord(request.facts) &&
          request.facts.kind === "session-manager-authority"
        ) {
          current = false;
          revoked = true;
        }
        callback(request, grant);
      }, attachment),
    );
  try {
    await expect(
      compact((prepared) =>
        persistCompactionBoundaryWithSessionEntryAsync(
          scope,
          { prepared, tokensAfter: 45, transcriptByteCompactionLatch: null },
          () => {
            if (!current) {
              throw ownerClosed;
            }
          },
        ),
      ),
    ).rejects.toThrow("compaction authority revoked");
    expect(revoked).toBe(true);
  } finally {
    observed.mockRestore();
  }
  expectRolledBack(scope, before);
});

it("recovers both transcript and accounting after a worker crash before compaction COMMIT", async () => {
  const scope = sessionScope("compaction-crash-before-commit");
  const { manager, keptId } = await seedCompaction(scope);
  const initialEntries = manager.getEntries();
  const before = loadTranscriptEventsSync(scope);
  const worker = await openOpenClawAgentSqliteWorkerStoreV2<SessionMetadataWorkerOperations>(
    toDatabaseOptions(resolveSqliteTranscriptScope(scope)),
    { version: 2, assertCurrent() {} },
    {
      moduleUrl: resolveRuntimeWorkerUrl(sessionNativeProcessEntrypoints.compactionCrash),
      input: undefined,
    },
  );
  const { env: _env, ...target } = scope;
  const prepared = preparedBoundary(target, keptId, "interrupted-compaction");
  try {
    await expect(
      worker.execute(
        {
          type: "session.transcript.compactionBoundary",
          input: { scope: target, prepared, tokensAfter: 45, transcriptByteCompactionLatch: null },
        },
        () => {},
      ),
    ).rejects.toMatchObject({
      code: "outcome-unknown",
      cause: expect.objectContaining({ message: "SQLite worker exited with code 92" }),
    });
  } finally {
    await worker.close();
  }
  expect((await SessionManager.openAsync(scope)).getEntries()).toEqual(initialEntries);
  expectRolledBack(scope, before);
  const recovered = await persistCompactionBoundaryWithSessionEntryAsync(scope, {
    prepared: { ...prepared, scope },
    tokensAfter: 45,
    transcriptByteCompactionLatch: null,
  });
  expect(recovered.entry).toMatchObject({ compactionCount: 1, totalTokens: 45 });
  expect(loadSessionEntry(scope)).toEqual(recovered.entry);
});

it("retains a committed receipt when accounting retargets the manager before publication", async () => {
  const scope = sessionScope("compaction-retarget-source", "source");
  const replacement = {
    ...scope,
    sessionId: "replacement",
    sessionKey: "agent:main:compaction-retarget-next",
  };
  const { manager, compact, persist } = await seedCompaction(scope);
  await upsertSessionEntryCore(replacement, { sessionId: replacement.sessionId, updatedAt: 1 });
  let committed: Awaited<ReturnType<typeof persist>> | undefined;
  const pending = compact(async (prepared) => {
    committed = await persist(prepared);
    // The independent retarget must not inherit the compaction's physical writer admission.
    await runInDetachedAsyncContext(() => manager.setSessionTargetAsync(replacement));
    return committed;
  });
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
    const scope = sessionScope("awaited-compaction-owner");
    const { compact, keptId } = await seedCompaction(scope);
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
              () => compact(),
            )
          : persistCompactionBoundaryWithSessionEntryAsync(fencedScope, {
              prepared: preparedBoundary(fencedScope, keptId, "queued-compaction"),
              transcriptByteCompactionLatch: byteLatch(scope),
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
  const scope = sessionScope("dashboard:incognito-awaited-compaction");
  const { manager, keptId, persist, compact } = await seedCompaction(scope, { incognito: true });
  const latch = byteLatch(scope);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const pending = compact(async (prepared) => {
    entered.resolve();
    await release.promise;
    return await persist(prepared);
  });
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
  expect((await loadTranscriptEvents(scope)).at(-1)).toMatchObject({
    id: entryId,
    type: "compaction",
  });
  expect(loadSessionEntry(scope)).toMatchObject({
    compactionCount: 1,
    transcriptByteCompactionLatch: latch,
  });

  await expect(
    persistCompactionBoundaryWithSessionEntryAsync(scope, {
      prepared: preparedBoundary(scope, keptId, entryId, { summary: "duplicate" }),
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
        prepared: preparedBoundary(scope, keptId, "closed-owner-compaction", {
          parentId: entryId,
          timestamp: new Date(2).toISOString(),
          summary: "Closed owner",
        }),
        transcriptByteCompactionLatch: latch,
      }),
    ).rejects.toBeInstanceOf(IncognitoSessionMissingError);
    expect(memorySessionActorOwners.read(owner)).toBeUndefined();
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});
it("rolls back accounting when the prepared boundary identity already exists", async () => {
  const scope = sessionScope("compaction-boundary-rollback", "session", false);
  const expected = {
    sessionId: scope.sessionId,
    lifecycleRevision: "lifecycle",
    activeWriterRunId: "writer",
  };
  const { keptId } = await seedCompaction(scope, expected);
  const before = loadTranscriptEventsSync(scope);

  expect(() =>
    persistCompactionBoundaryWithSessionEntrySync(
      {
        ...scope,
        expectedLifecycleRevision: expected.lifecycleRevision,
        expectedWriterRunId: expected.activeWriterRunId,
      },
      {
        prepared: preparedBoundary(scope, keptId, keptId),
        transcriptByteCompactionLatch: byteLatch(scope),
      },
    ),
  ).toThrow(`Session transcript entry was not persisted: ${keptId}: transcript-event-not-appended`);

  expectRolledBack(scope, before);
});

it("rolls back when the admitted writer rejects the appended boundary", async () => {
  const scope = sessionScope("compaction-boundary-owner", "session", false);
  const { keptId } = await seedCompaction(scope);
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
          prepared: preparedBoundary(scope, keptId, "prepared-compaction"),
          transcriptByteCompactionLatch: byteLatch(scope),
        }),
    ),
  ).rejects.toBe(ownerClosed);

  expectRolledBack(scope, before);
});
