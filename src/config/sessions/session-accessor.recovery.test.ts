import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  isSqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  recoverSessionEntryFromRestartTombstone,
  replaceSessionEntry,
} from "./session-accessor.js";
import { readSessionTranscriptMessageEventPage } from "./session-accessor.sqlite-active-events.js";
import { readPreparedSessionEntryChange } from "./session-accessor.sqlite-entry-cache-publication.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "./session-transcript-reconcile.js";
import type { InternalSessionEntry } from "./types.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-recovery-");

async function createFixture() {
  const root = sessionDirs.make();
  const storePath = path.join(root, "sessions.json");
  const sourceKey = "agent:main:dashboard:tombstoned";
  const successorKey = "agent:main:dashboard:recovered";
  const sourceSessionId = "source-session";
  await replaceSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath }, {
    sessionId: sourceSessionId,
    updatedAt: 10,
    pinnedAt: 5,
    pluginOwnerId: "codex",
    mainRestartRecovery: {
      cycleId: "cycle-1",
      revision: 4,
      chargedAttempts: 3,
      tombstone: { reason: "automatic recovery exhausted" },
    },
  } as InternalSessionEntry);
  await replaceTranscriptEvents(
    { agentId: "main", sessionId: sourceSessionId, sessionKey: sourceKey, storePath },
    [
      {
        type: "session",
        version: 3,
        id: sourceSessionId,
        timestamp: "2026-08-12T00:00:00.000Z",
        cwd: root,
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-08-12T00:00:01.000Z",
        message: { role: "user", content: "finish this" },
      },
      {
        type: "message",
        id: "side-branch",
        parentId: "user-1",
        timestamp: "2026-08-12T00:00:02.000Z",
        message: { role: "assistant", content: "preserve the whole transcript" },
      },
      {
        type: "leaf",
        id: "leaf-1",
        parentId: "side-branch",
        timestamp: "2026-08-12T00:00:03.000Z",
        targetId: "user-1",
      },
    ],
  );
  return { root, sourceKey, sourceSessionId, storePath, successorKey };
}

describe("recoverSessionEntryFromRestartTombstone", () => {
  it("clones and publishes the atomic archived successor transition without host SQLite", async () => {
    const fixture = await createFixture();
    await waitForSessionTranscriptIndexReconcilesInStateDir(fixture.root);
    const successorEntry = {
      sessionId: "successor-session",
      updatedAt: 20,
      spawnDepth: 0,
      label: "Recovered session",
    };
    const params = {
      agentId: "main",
      expected: {
        cycleId: "cycle-1",
        revision: 4,
        sessionId: fixture.sourceSessionId,
        pluginOwnerId: "codex",
      },
      sourceTarget: { canonicalKey: fixture.sourceKey, storeKeys: [fixture.sourceKey] },
      storePath: fixture.storePath,
      successorEntry,
      successorTarget: { canonicalKey: fixture.successorKey, storeKeys: [fixture.successorKey] },
    };

    const createdKeys: string[] = [];
    const publications: Array<ReturnType<typeof readPreparedSessionEntryChange>> = [];
    const changedKeys: string[] = [];
    const stopIdentity = onSessionIdentityMutation((mutation) => {
      if (mutation.kind === "create") {
        createdKeys.push(...mutation.current.sessionKeys);
        publications.push(readPreparedSessionEntryChange(mutation, fixture.successorKey));
      }
    });
    const stopChanges = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change) {
        changedKeys.push(change.sessionKey);
      }
    });
    const sql = observeHostDataSql();
    try {
      const created = await recoverSessionEntryFromRestartTombstone(params);
      expect(created).toMatchObject({ status: "created", successorKey: fixture.successorKey });
      expect(sql.queries).toEqual([]);
      expect(createdKeys).toEqual([fixture.successorKey]);
      expect(publications).toEqual([
        expect.objectContaining({
          entry: expect.objectContaining(successorEntry),
          source: expect.objectContaining({ revision: expect.any(Number) }),
        }),
      ]);
      expect(changedKeys).toEqual(
        expect.arrayContaining([fixture.sourceKey, fixture.successorKey]),
      );
    } finally {
      sql.restore();
      stopIdentity();
      stopChanges();
    }
    await waitForSessionTranscriptIndexReconcilesInStateDir(fixture.root);
    expect(
      readSessionTranscriptMessageEventPage(
        {
          agentId: "main",
          sessionId: successorEntry.sessionId,
          sessionKey: fixture.successorKey,
          storePath: fixture.storePath,
        },
        { maxMessages: 10, offset: 0, readOnly: true },
      ),
    ).toMatchObject({
      activeLeafEntryId: "user-1",
      totalMessages: 1,
      events: [expect.objectContaining({ event: expect.objectContaining({ id: "user-1" }) })],
    });
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.sourceKey,
        storePath: fixture.storePath,
      }),
    ).toMatchObject({
      archivedAt: expect.any(Number),
      archiveReason: "restart-recovery",
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 5,
        tombstone: {
          recoveredSessionId: "successor-session",
          recoveredSessionKey: fixture.successorKey,
        },
      },
    });
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.successorKey,
        storePath: fixture.storePath,
      }),
    ).toMatchObject(successorEntry);
    const recoveredEvents = await loadTranscriptEvents({
      agentId: "main",
      sessionId: successorEntry.sessionId,
      sessionKey: fixture.successorKey,
      storePath: fixture.storePath,
    });
    expect(recoveredEvents).toHaveLength(4);
    expect(recoveredEvents[0]).toMatchObject({
      type: "session",
      id: successorEntry.sessionId,
      version: 3,
    });
    expect(JSON.stringify(recoveredEvents)).toContain("preserve the whole transcript");

    const repeated = await recoverSessionEntryFromRestartTombstone({
      ...params,
      successorEntry: { sessionId: "unused-session", updatedAt: 30 },
      successorTarget: {
        canonicalKey: "agent:main:dashboard:unused",
        storeKeys: ["agent:main:dashboard:unused"],
      },
    });
    expect(repeated).toMatchObject({
      status: "existing",
      successorKey: fixture.successorKey,
      successorEntry: { sessionId: successorEntry.sessionId },
    });
    for (const changed of [
      { sessionId: "different-session" },
      { lifecycleRevision: "different-lifecycle" },
      { cycleId: "different-cycle" },
      { pluginOwnerId: "different-owner" },
    ]) {
      await expect(
        recoverSessionEntryFromRestartTombstone({
          ...params,
          expected: { ...params.expected, ...changed },
        }),
      ).resolves.toEqual({ status: "conflict", reason: "source-changed" });
    }
  });

  it.each([
    { name: "recovery", revision: 3 },
    { name: "lifecycle", revision: 4, lifecycleRevision: "different-generation" },
  ])("does not archive or copy when the $name revision changed", async (expected) => {
    const fixture = await createFixture();
    const result = await recoverSessionEntryFromRestartTombstone({
      agentId: "main",
      expected: {
        cycleId: "cycle-1",
        revision: expected.revision,
        ...(expected.lifecycleRevision ? { lifecycleRevision: expected.lifecycleRevision } : {}),
        sessionId: fixture.sourceSessionId,
        pluginOwnerId: "codex",
      },
      sourceTarget: { canonicalKey: fixture.sourceKey, storeKeys: [fixture.sourceKey] },
      storePath: fixture.storePath,
      successorEntry: { sessionId: "successor-session", updatedAt: 20 },
      successorTarget: { canonicalKey: fixture.successorKey, storeKeys: [fixture.successorKey] },
    });
    expect(result).toEqual({ status: "conflict", reason: "source-changed" });
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.sourceKey,
        storePath: fixture.storePath,
      })?.archivedAt,
    ).toBeUndefined();
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.successorKey,
        storePath: fixture.storePath,
      }),
    ).toBeUndefined();
  });

  it.each(["transaction", "commit"] as const)(
    "rolls back the entire clone when host authority is revoked at %s admission",
    async (stage) => {
      const fixture = await createFixture();
      let current = true;
      using intercepted = probe.admission(admission, (request, grant, callback) => {
        if (request.stage === stage) {
          current = false;
        }
        callback(request, grant);
      });
      const published = vi.fn();
      const stop = onSessionIdentityMutation(published);
      try {
        await expect(
          recoverSessionEntryFromRestartTombstone({
            agentId: "main",
            expected: {
              cycleId: "cycle-1",
              revision: 4,
              sessionId: fixture.sourceSessionId,
              pluginOwnerId: "codex",
            },
            sourceTarget: { canonicalKey: fixture.sourceKey, storeKeys: [fixture.sourceKey] },
            storePath: fixture.storePath,
            successorEntry: { sessionId: "refused-successor", updatedAt: 20 },
            successorTarget: {
              canonicalKey: fixture.successorKey,
              storeKeys: [fixture.successorKey],
            },
            commitGuard: () => {
              if (!current) {
                throw new Error("Recovery authority revoked");
              }
            },
          }),
        ).rejects.toThrow("Recovery authority revoked");
        expect(current).toBe(false);
        expect(published).not.toHaveBeenCalled();
      } finally {
        stop();
        intercepted.mockRestore();
      }
      expect(
        loadSessionEntry({
          agentId: "main",
          sessionKey: fixture.sourceKey,
          storePath: fixture.storePath,
        }),
      ).toMatchObject({ pinnedAt: 5, mainRestartRecovery: { revision: 4 } });
      expect(
        loadSessionEntry({
          agentId: "main",
          sessionKey: fixture.successorKey,
          storePath: fixture.storePath,
        }),
      ).toBeUndefined();
      expect(
        await loadTranscriptEvents({
          agentId: "main",
          sessionId: "refused-successor",
          sessionKey: fixture.successorKey,
          storePath: fixture.storePath,
        }),
      ).toEqual([]);
    },
  );

  it.each([
    {
      label: "fences a missing receipt and result",
      missingReceipt: true,
      retireOwner: false,
      loseResult: true,
    },
    {
      label: "repairs a committed recovery after result loss",
      missingReceipt: false,
      retireOwner: false,
      loseResult: true,
    },
    {
      label: "preserves result loss after committed owner retirement",
      missingReceipt: false,
      retireOwner: true,
      loseResult: true,
    },
    {
      label: "preserves recovery success after committed owner retirement",
      missingReceipt: false,
      retireOwner: true,
      loseResult: false,
    },
  ])("$label", async ({ missingReceipt, retireOwner, loseResult }) => {
    const fixture = await createFixture();
    await waitForSessionTranscriptIndexReconcilesInStateDir(fixture.root);
    const params = {
      agentId: "main",
      expected: {
        cycleId: "cycle-1",
        revision: 4,
        sessionId: fixture.sourceSessionId,
        pluginOwnerId: "codex",
      },
      sourceTarget: { canonicalKey: fixture.sourceKey, storeKeys: [fixture.sourceKey] },
      storePath: fixture.storePath,
      successorEntry: { sessionId: "settled-successor", updatedAt: 20 },
      successorTarget: { canonicalKey: fixture.successorKey, storeKeys: [fixture.successorKey] },
    };
    const deliveryFailure = new Error("Recovery result delivery failed");
    const databaseOptions = toDatabaseOptions(
      resolveSqliteReadScope({
        agentId: "main",
        sessionKey: fixture.sourceKey,
        storePath: fixture.storePath,
      }),
    );
    let closing: Promise<boolean> | undefined;
    const restoreFaults: Array<() => void> = [];
    let dropReceipt = missingReceipt;
    let verifiedCommands = 0;
    const runOperation = workerStore.runSqliteWorkerStoreOperation;
    const captures = vi.spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution");
    const observer = vi
      .spyOn(workerStore, "runSqliteWorkerStoreOperation")
      .mockImplementation(
        <Operations extends SqliteWorkerOperations, T>(
          store: SqliteWorkerStore<Operations>,
          operation: (worker: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
          stateContext?: Parameters<typeof runOperation>[2],
          assertCurrent?: Parameters<typeof runOperation>[3],
          createAdmission?: Parameters<typeof runOperation>[4],
        ) => {
          let recovering = false;
          let nativeAdmission: admission.SqliteWorkerOperationAdmission | undefined;
          return runOperation(
            store,
            (worker) =>
              operation({
                execute: async (command, options) => {
                  recovering = command.type === "session.restart.recover";
                  const result = await worker.execute(command, options);
                  if (!recovering) {
                    return result;
                  }
                  if (!nativeAdmission) {
                    throw new Error("Recovery did not retain native admission");
                  }
                  // Observe the actual commit before simulating lost receipt/result delivery.
                  expect(nativeAdmission.committed).toMatchObject({
                    facts: {
                      kind:
                        verifiedCommands === 0
                          ? "session-entry-replacements"
                          : "session-restart-recovery-unchanged",
                    },
                  });
                  expect(nativeAdmission.settlement?.kind).toBe("completed");
                  verifiedCommands++;
                  if (retireOwner && verifiedCommands === 1) {
                    // Retirement belongs to an independent caller after the native commit.
                    closing = runInDetachedAsyncContext(() =>
                      closeOpenClawAgentDatabaseByPathAsync(
                        resolveOpenClawAgentSqlitePath(databaseOptions),
                        "main",
                      ),
                    );
                    void closing.catch(() => undefined);
                    captures.mockClear();
                  }
                  if (dropReceipt) {
                    const receipt = vi
                      .spyOn(nativeAdmission, "committed", "get")
                      .mockReturnValue(undefined);
                    const settlement = vi
                      .spyOn(nativeAdmission, "settlement", "get")
                      .mockReturnValue({ kind: "completed" });
                    restoreFaults.push(
                      () => receipt.mockRestore(),
                      () => settlement.mockRestore(),
                    );
                  }
                  if (loseResult) {
                    throw deliveryFailure;
                  }
                  return result;
                },
              }),
            stateContext,
            assertCurrent,
            createAdmission &&
              ((retained) => {
                const owned = createAdmission(retained);
                if (recovering) {
                  nativeAdmission = owned.admission;
                }
                return owned;
              }),
          );
        },
      );
    try {
      let delivered:
        | Awaited<ReturnType<typeof recoverSessionEntryFromRestartTombstone>>
        | undefined;
      const outcome = await recoverSessionEntryFromRestartTombstone(params).then(
        (value) => {
          delivered = value;
          return undefined;
        },
        (error: unknown) => error,
      );
      if (missingReceipt) {
        expect(isSqliteWorkerError(outcome, "outcome-unknown")).toBe(true);
      } else if (loseResult) {
        expect(outcome).toBe(deliveryFailure);
      } else {
        expect(outcome).toBeUndefined();
        expect(delivered).toMatchObject({ status: "created", successorKey: fixture.successorKey });
      }
      await closing;
      if (retireOwner) {
        expect(captures).not.toHaveBeenCalled();
      }
      captures.mockRestore();
      expect(
        loadSessionEntry({
          agentId: "main",
          sessionKey: fixture.successorKey,
          storePath: fixture.storePath,
        }),
      ).toMatchObject(params.successorEntry);
      await waitForSessionTranscriptIndexReconcilesInStateDir(fixture.root);
      const readProjection = () =>
        readSessionTranscriptMessageEventPage(
          {
            agentId: "main",
            sessionId: params.successorEntry.sessionId,
            sessionKey: fixture.successorKey,
            storePath: fixture.storePath,
          },
          { maxMessages: 10, offset: 0, readOnly: true },
        );
      if (missingReceipt || retireOwner) {
        expect(readProjection).toThrow("projection is rebuilding");
      } else {
        expect(readProjection()).toMatchObject({ activeLeafEntryId: "user-1", totalMessages: 1 });
      }
      for (const restore of restoreFaults.splice(0)) {
        restore();
      }
      dropReceipt = false;
      if (loseResult) {
        await expect(recoverSessionEntryFromRestartTombstone(params)).rejects.toBe(deliveryFailure);
      } else {
        await expect(recoverSessionEntryFromRestartTombstone(params)).resolves.toMatchObject({
          status: "existing",
        });
      }
      expect(verifiedCommands).toBe(2);
    } finally {
      captures.mockRestore();
      observer.mockRestore();
      for (const restore of restoreFaults) {
        restore();
      }
      await closing;
    }
  });
});
