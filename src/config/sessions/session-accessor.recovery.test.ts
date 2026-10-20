import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { renderStorageFailureSummary } from "../../agents/failover/assistant-request-failure-copy.js";
import { formatErrorMessageWithCode } from "../../infra/errors.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
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
  patchSessionEntryCore,
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
      { type: "session", version: 3, id: sourceSessionId, cwd: root },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        message: { role: "user", content: "finish this" },
      },
      {
        type: "message",
        id: "side-branch",
        parentId: "user-1",
        message: { role: "assistant", content: "preserve the whole transcript" },
      },
      { type: "leaf", id: "leaf-1", parentId: "side-branch", targetId: "user-1" },
    ],
  );
  const scope = (sessionKey = sourceKey) => ({ agentId: "main", storePath, sessionKey });
  const recoveryParams = (sessionId = "successor-session") => ({
    agentId: "main",
    storePath,
    expected: {
      cycleId: "cycle-1",
      revision: 4,
      sessionId: sourceSessionId,
      pluginOwnerId: "codex",
    },
    sourceTarget: { canonicalKey: sourceKey, storeKeys: [sourceKey] },
    successorTarget: { canonicalKey: successorKey, storeKeys: [successorKey] },
    successorEntry: { sessionId, updatedAt: 20 },
  });
  return { root, sourceKey, successorKey, scope, recoveryParams };
}

describe("recoverSessionEntryFromRestartTombstone", () => {
  it("clones and publishes the atomic archived successor transition without host SQLite", async () => {
    const fixture = await createFixture();
    await patchSessionEntryCore(fixture.scope(), () => ({ label: "Latest source metadata" }));
    await waitForSessionTranscriptIndexReconcilesInStateDir(fixture.root);
    const successorEntry = {
      sessionId: "successor-session",
      updatedAt: 20,
      spawnDepth: 0,
      label: "Recovered session",
    };
    const params = { ...fixture.recoveryParams(), successorEntry };

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
      expect(publications).toMatchObject([
        { entry: successorEntry, source: { revision: expect.any(Number) } },
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
        { ...fixture.scope(fixture.successorKey), sessionId: successorEntry.sessionId },
        { maxMessages: 10, offset: 0, readOnly: true },
      ),
    ).toMatchObject({
      activeLeafEntryId: "user-1",
      totalMessages: 1,
      events: [{ event: { id: "user-1" } }],
    });
    expect(loadSessionEntry(fixture.scope(fixture.sourceKey))).toMatchObject({
      archivedAt: expect.any(Number),
      archiveReason: "restart-recovery",
      label: "Latest source metadata",
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 5,
        tombstone: {
          recoveredSessionId: "successor-session",
          recoveredSessionKey: fixture.successorKey,
        },
      },
    });
    expect(loadSessionEntry(fixture.scope(fixture.successorKey))).toMatchObject(successorEntry);
    const recoveredEvents = await loadTranscriptEvents({
      ...fixture.scope(fixture.successorKey),
      sessionId: successorEntry.sessionId,
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
    ["recovery", { revision: 3 }],
    ["lifecycle", { revision: 4, lifecycleRevision: "different-generation" }],
  ] as const)("does not archive or copy when the %s revision changed", async (_name, expected) => {
    const fixture = await createFixture();
    const result = await recoverSessionEntryFromRestartTombstone({
      ...fixture.recoveryParams(),
      expected: { ...fixture.recoveryParams().expected, ...expected },
    });
    expect(result).toEqual({ status: "conflict", reason: "source-changed" });
    expect(loadSessionEntry(fixture.scope(fixture.sourceKey))?.archivedAt).toBeUndefined();
    expect(loadSessionEntry(fixture.scope(fixture.successorKey))).toBeUndefined();
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
            ...fixture.recoveryParams("refused-successor"),
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
      expect(loadSessionEntry(fixture.scope(fixture.sourceKey))).toMatchObject({
        pinnedAt: 5,
        mainRestartRecovery: { revision: 4 },
      });
      expect(loadSessionEntry(fixture.scope(fixture.successorKey))).toBeUndefined();
      expect(
        await loadTranscriptEvents({
          ...fixture.scope(fixture.successorKey),
          sessionId: "refused-successor",
        }),
      ).toEqual([]);
    },
  );

  it.each([
    ["fences a missing receipt and result", true, false, true, false],
    ["preserves a distinct storage settlement failure after result loss", true, false, true, true],
    ["repairs a committed recovery after result loss", false, false, true, false],
    ["preserves result loss after committed owner retirement", false, true, true, false],
    ["preserves recovery success after committed owner retirement", false, true, false, false],
  ] as const)("%s", async (_label, missingReceipt, retireOwner, loseResult, storageSettlement) => {
    const fixture = await createFixture();
    await waitForSessionTranscriptIndexReconcilesInStateDir(fixture.root);
    const params = fixture.recoveryParams("settled-successor");
    const deliveryFailure = new Error("Recovery result delivery failed");
    const settlementFailure = new Error("Recovery settlement failed", {
      cause: Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" }),
    });
    const databaseOptions = toDatabaseOptions(resolveSqliteReadScope(fixture.scope()));
    let closing: Promise<boolean> | undefined;
    const restoreFaults: Array<() => void> = [];
    let dropReceipt = missingReceipt;
    let verifiedCommands = 0;
    const runOperation = workerStore.runSqliteWorkerStoreOperation;
    const captures = [
      vi.spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution"),
      vi.spyOn(agentExecution, "captureOpenClawAgentDatabasePreparationExecution"),
    ];
    const restoreCaptures = () => captures.forEach((capture) => capture.mockRestore());
    const restoreReceipts = () => {
      for (const restore of restoreFaults.splice(0)) {
        restore();
      }
    };
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
                    captures.forEach((capture) => capture.mockClear());
                  }
                  if (dropReceipt) {
                    const receipt = vi
                      .spyOn(nativeAdmission, "committed", "get")
                      .mockReturnValue(undefined);
                    const settlement = vi
                      .spyOn(nativeAdmission, "settlement", "get")
                      .mockReturnValue({ kind: storageSettlement ? "unknown" : "completed" });
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
                const owned = createAdmission(
                  recovering && storageSettlement && dropReceipt
                    ? {
                        settled: retained.settled.then(() => ({
                          kind: "unknown",
                          error: settlementFailure,
                        })),
                      }
                    : retained,
                );
                if (recovering) {
                  nativeAdmission = owned.admission;
                }
                return owned;
              }),
          );
        },
      );
    try {
      const { delivered, outcome } = await recoverSessionEntryFromRestartTombstone(params).then(
        (value) => ({ delivered: value, outcome: undefined }),
        (error: unknown) => ({ delivered: undefined, outcome: error }),
      );
      if (missingReceipt) {
        expect(isSqliteWorkerError(outcome, "outcome-unknown")).toBe(true);
        if (storageSettlement) {
          const diagnostic = formatErrorMessageWithCode(outcome);
          expect(diagnostic).toContain("Recovery result delivery failed");
          expect(diagnostic).toContain("Recovery settlement failed");
          expect(diagnostic).toContain("database or disk is full");
          expect(renderStorageFailureSummary(classifyGatewayStorageFailure(outcome))).toBe(
            "OpenClaw couldn't save your conversation because the disk is full. Free up space on the computer running OpenClaw before continuing.",
          );
        }
      } else if (loseResult) {
        expect(outcome).toBe(deliveryFailure);
      } else {
        expect(outcome).toBeUndefined();
        expect(delivered).toMatchObject({ status: "created", successorKey: fixture.successorKey });
      }
      await closing;
      if (retireOwner) {
        captures.forEach((capture) => expect(capture).not.toHaveBeenCalled());
      }
      restoreCaptures();
      expect(loadSessionEntry(fixture.scope(fixture.successorKey))).toMatchObject(
        params.successorEntry,
      );
      await waitForSessionTranscriptIndexReconcilesInStateDir(fixture.root);
      const readProjection = () =>
        readSessionTranscriptMessageEventPage(
          { ...fixture.scope(fixture.successorKey), sessionId: params.successorEntry.sessionId },
          { maxMessages: 10, offset: 0, readOnly: true },
        );
      if (missingReceipt || retireOwner) {
        expect(readProjection).toThrow("projection is rebuilding");
      } else {
        expect(readProjection()).toMatchObject({ activeLeafEntryId: "user-1", totalMessages: 1 });
      }
      restoreReceipts();
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
      restoreCaptures();
      observer.mockRestore();
      restoreReceipts();
      await closing;
    }
  });
});
