import { afterEach, expect, test, vi } from "vitest";
import { claimAgentSessionWriter } from "../agents/embedded-agent-runner/run/session-bootstrap.js";
import { commitMainSessionRecovery } from "../agents/main-session-recovery/main-session-recovery-store.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as sessionEntryReads from "../config/sessions/session-entry-read-runtime.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as storeWrites from "../shared/store-writer-queue.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { recoverGatewaySession } from "./session-recovery-service.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  seedSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
  getGatewayConfigModule,
} from "./test/server-sessions.test-helpers.js";
import { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import type { WorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test.each([false, true])(
  "same-session Goal pause decision retries a rejected continuation with current authority (revoked: %s)",
  async (revoked) => {
    const { storePath } = await createSessionStoreDir();
    const key = "agent:main:dashboard:uncertain-effect";
    const sessionId = "uncertain-effect-session";
    await writeSessionStore({
      entries: {
        [key]: sessionStoreEntry(sessionId, {
          status: "interrupted",
          abortedLastRun: true,
          goal: {
            schemaVersion: 1,
            id: "reviewed-goal",
            objective: "Synthetic Goal",
            status: "paused",
            createdAt: 1,
            updatedAt: 100,
            tokenStart: 0,
            tokensUsed: 0,
            continuationTurns: 0,
          },
          goalPauseOrigin: "recovery-hold",
          mainRestartRecovery: {
            cycleId: "uncertain-cycle",
            revision: 1,
            chargedAttempts: 0,
            pause: {
              reason: "unverifiable-external-effect",
              toolCallId: "send-1",
              pausedAtMs: 100,
              goalId: "reviewed-goal",
            },
          },
        }),
      },
    });
    const { getRuntimeConfig: readRuntimeConfig } = await getGatewayConfigModule();
    let current = true;
    const launchContinuation = vi
      .fn<Parameters<typeof recoverGatewaySession>[0]["launchContinuation"]>()
      .mockResolvedValueOnce({
        status: "rejected",
        error: { code: "UNAVAILABLE", message: "runtime closed before admission" },
      })
      .mockResolvedValue({ status: "started", runId: "continued-once" });
    const request = () =>
      recoverGatewaySession({
        cfg: readRuntimeConfig(),
        key,
        actor: { type: "human", source: "profile", id: "test-operator" },
        workerPlacementContext: {},
        launchContinuation,
        commitGuard: () => {
          if (!current) {
            throw new Error("caller authority revoked");
          }
        },
      });
    expect(await request()).toMatchObject({
      ok: true,
      created: false,
      successorKey: key,
      successorEntry: { sessionId },
      continuation: { status: "rejected" },
    });
    current = !revoked;
    if (revoked) {
      await expect(request()).rejects.toThrow("caller authority revoked");
      expect(launchContinuation).toHaveBeenCalledTimes(1);
    } else {
      expect(await request()).toMatchObject({
        ok: true,
        created: false,
        successorKey: key,
        successorEntry: { sessionId },
        continuation: { status: "started" },
      });
      expect(launchContinuation).toHaveBeenCalledTimes(2);
      expect(launchContinuation.mock.calls[1]?.[0]).toEqual(launchContinuation.mock.calls[0]?.[0]);
    }
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
      sessionId,
      mainRestartRecovery: { acknowledgedPause: { toolCallId: "send-1" } },
    });
  },
);

test.each([false, true])(
  "concurrent cloud recovery waits for its canonical successor and rechecks queued authority (revoked: %s)",
  async (revokeAuthority) => {
    const { storePath } = await createSessionStoreDir();
    const sourceKey = "agent:main:dashboard:concurrent-cloud-recovery";
    const sourceSessionId = "concurrent-cloud-recovery-source";
    await writeSessionStore({
      entries: {
        [sourceKey]: sessionStoreEntry(sourceSessionId, {
          status: "failed",
          abortedLastRun: true,
          mainRestartRecovery: {
            cycleId: "concurrent-recovery-cycle",
            revision: 1,
            chargedAttempts: 3,
            tombstone: { reason: "automatic recovery exhausted" },
          },
        }),
      },
    });
    await seedSessionTranscript({
      agentId: "main",
      sessionId: sourceSessionId,
      sessionKey: sourceKey,
      storePath,
      messages: [{ role: "user", content: "recover the interrupted cloud workspace" }],
    });
    let placement = {
      sessionId: sourceSessionId,
      sessionKey: sourceKey,
      agentId: "main",
      state: "active",
      generation: 2,
      environmentId: "worker-env",
      activeOwnerEpoch: 1,
      turnClaim: null,
    } as WorkerSessionPlacementRecord;
    const reclaimEntered = createDeferredCore();
    const startReclaim = createDeferredCore();
    const reclaimed = createDeferredCore();
    const releaseResult = createDeferredCore();
    let reclaimCalls = 0;
    const service = coordinateWorkerPlacementDispatch(
      {
        reclaim: async (_request, authorize, beforeDrain, serialize) => {
          const first = ++reclaimCalls === 1;
          const result = await serialize!(async () => {
            if (first) {
              reclaimEntered.resolve();
              await startReclaim.promise;
            }
            authorize?.();
            beforeDrain?.();
            placement = {
              ...placement,
              state: "reclaimed",
              generation: placement.generation + 1,
            } as WorkerSessionPlacementRecord;
            return placement as Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;
          });
          if (first) {
            reclaimed.resolve();
            await releaseResult.promise;
          }
          return result;
        },
      } as WorkerPlacementDispatchService,
      (_request, run) => run(),
    );
    const context = {
      workerPlacementDispatchService: service,
      workerSessionPlacementService: { getMany: () => new Map([[sourceSessionId, placement]]) },
    };
    type RecoveryPayload = { key: string; sessionId: string };
    const first = directSessionReq<RecoveryPayload>(
      "sessions.recover",
      { key: sourceKey },
      { context },
    );
    await reclaimEntered.promise;
    const secondQueued = createDeferredCore();
    const secondRead = createDeferredCore();
    const releaseRead = createDeferredCore();
    const runQueuedStoreWrite = storeWrites.runQueuedStoreWrite;
    const queueObserver = vi
      .spyOn(storeWrites, "runQueuedStoreWrite")
      .mockImplementation((params) => {
        if (params.label === "recoverGatewaySession") {
          secondQueued.resolve();
        }
        return runQueuedStoreWrite(params);
      });
    const readEntry = sessionEntryReads.withSessionEntryReadOnlyInWorker;
    let holdNextRead = true;
    const readObserver = vi
      .spyOn(sessionEntryReads, "withSessionEntryReadOnlyInWorker")
      .mockImplementation((input, assertCurrent, consume) => {
        const hold = holdNextRead && input.sessionKey === sourceKey;
        if (hold) {
          holdNextRead = false;
        }
        return readEntry(input, assertCurrent, async (result, owner) => {
          const value = await consume(result, owner);
          if (hold) {
            secondRead.resolve();
            await releaseRead.promise;
          }
          return value;
        });
      });
    let authorityActive = true;
    let secondSettled = false;
    const second = directSessionReq<RecoveryPayload>(
      "sessions.recover",
      { key: sourceKey },
      {
        client: {
          connect: { scopes: ["operator.write"] },
          internal: {
            agentRuntimeIdentity: { kind: "agentRuntime", agentId: "main", sessionKey: sourceKey },
          },
        } as never,
        context: {
          ...context,
          validateAgentRuntimeApprovalAuthority: () => authorityActive,
        },
      },
    ).finally(() => {
      secondSettled = true;
    });
    let settledBeforeCommit = false;
    try {
      // Let the winner publish while any unqueued source read is still in flight.
      // Correct recovery queues before acquiring facts, so it reaches the other gate.
      await Promise.race([secondRead.promise, secondQueued.promise]);
      holdNextRead = false;
      authorityActive = !revokeAuthority;
      startReclaim.resolve();
      await reclaimed.promise;
      // The placement queue is free, but the winner has not published its successor.
      settledBeforeCommit = secondSettled;
      releaseResult.resolve();
      await first;
    } finally {
      startReclaim.resolve();
      releaseResult.resolve();
      releaseRead.resolve();
      await Promise.allSettled([first, second]);
      readObserver.mockRestore();
      queueObserver.mockRestore();
    }
    const winner = await first;
    expect(winner.ok, JSON.stringify(winner.error)).toBe(true);
    expect(settledBeforeCommit).toBe(false);
    if (revokeAuthority) {
      expect(await second).toMatchObject({
        ok: false,
        error: { message: "agent runtime authority is no longer active" },
      });
    } else {
      expect(await second).toMatchObject({
        ok: true,
        payload: { key: winner.payload?.key, sessionId: winner.payload?.sessionId },
      });
    }
    expect(loadSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath })).toMatchObject({
      mainRestartRecovery: {
        tombstone: {
          recoveredSessionKey: winner.payload?.key,
          recoveredSessionId: winner.payload?.sessionId,
        },
      },
    });
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: winner.payload!.key, storePath }),
    ).toMatchObject({ sessionId: winner.payload?.sessionId, previousSessionId: sourceSessionId });
  },
);

test.each([
  { name: "admitted", status: undefined, admitted: true, live: false },
  { name: "failed", status: "failed", admitted: false, live: false },
  { name: "failed", status: "failed", admitted: false, live: true },
  { name: "statusless", status: undefined, admitted: false, live: false },
  { name: "done", status: "done", admitted: false, live: false },
  { name: "killed", status: "killed", admitted: false, live: false },
] as const)(
  "sessions.recover reconciles a $name interrupted writer only without a live owner (live=$live)",
  async ({ status, live, admitted }) => {
    const { dir, storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:dashboard:orphaned-recovery";
    const sessionId = "orphaned-recovery-session";
    const runId = "orphaned-recovery-run";
    const cycleId = "orphaned-recovery-cycle";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const target = { agentId: "main", sessionKey, storePath };
    await writeSessionStore({ entries: { [sessionKey]: { sessionId, updatedAt: 1_000 } } });
    await persistGatewaySessionLifecycleEvent({
      sessionKey,
      event: {
        ts: 1_000,
        runId,
        sessionId,
        lifecycleGeneration,
        data: { phase: "start", startedAt: 1_000 },
      },
    });
    await commitMainSessionRecovery({
      target,
      command: { kind: "mark_interrupted", cycleId, now: 2_000 },
    });
    await commitMainSessionRecovery({
      target,
      command: {
        kind: "prepare_attempt",
        attempt: 1,
        lifecycleGeneration,
        now: 3_000,
        observation: { sessionId, cycleId, revision: 1 },
        runId,
        executionIdentity: { state: "disabled" },
      },
    });
    await commitMainSessionRecovery({
      target,
      command: { kind: "admit_recovery", sessionId, runId, lifecycleGeneration, now: 3_000 },
    });
    await commitMainSessionRecovery({
      target,
      command: {
        kind: "register_recovery_turn",
        sessionId,
        runId,
        lifecycleGeneration,
        cycleId,
        attempt: 1,
      },
    });
    await claimAgentSessionWriter({
      sessionId,
      sessionKey,
      sessionTarget: { ...target, sessionId },
      workspaceDir: dir,
      config: getRuntimeConfig(),
      prompt: "finish the interrupted work",
      timeoutMs: 60_000,
      runId,
    });
    await seedSessionTranscript({
      ...target,
      sessionId,
      messages: [{ role: "user", content: "preserve this conversation" }],
    });
    if (!admitted) {
      await patchSessionEntryCore(target, () => ({
        status,
        ...(status === undefined ? { abortedLastRun: undefined } : {}),
        lifecycleRunId: undefined,
        lastRunId: "rejected-foreground-turn",
        restartRecoveryDeliveryRunId: "rejected-foreground-turn",
        restartRecoveryDeliverySourceRunId: "rejected-foreground-turn",
      }));
    }
    const stranded = loadSessionEntry(target);
    expect(stranded?.status).toBe(status);
    expect(stranded?.abortedLastRun).toBe(!admitted && status === undefined ? undefined : false);
    expect(stranded).toMatchObject({
      activeWriterRunId: runId,
      ...(admitted ? { lifecycleRunId: runId } : {}),
      mainRestartRecovery: { cycleId, revision: 4, chargedAttempts: 1, startedAttempt: 1 },
      restartRecoveryRuns: [{ runId, lifecycleGeneration }],
    });
    expect(stranded?.restartRecoveryTerminalRunIds).toBeUndefined();
    const liveClaim = live
      ? claimAgentRunContext(
          runId,
          { sessionKey, sessionId, lifecycleGeneration },
          { trackOwner: true },
        )
      : undefined;
    try {
      const recovered = await directSessionReq("sessions.recover", {
        agentId: "main",
        key: sessionKey,
      });
      if (live || status === "done" || status === "killed") {
        expect(recovered.ok).toBe(false);
        expect(loadSessionEntry(target)).toEqual(stranded);
        return;
      }
      expect(recovered.ok, JSON.stringify(recovered.error)).toBe(true);
      expect(recovered.payload).toMatchObject({
        key: sessionKey,
        sessionId,
        continuation: { status: "started" },
      });
      const restored = loadSessionEntry(target);
      expect(restored?.archivedAt).toBeUndefined();
      expect(restored?.activeWriterRunId).not.toBe(runId);
      expect(restored?.lifecycleRunId).not.toBe(runId);
      expect(JSON.stringify(await loadTranscriptEvents({ ...target, sessionId }))).toContain(
        "preserve this conversation",
      );
    } finally {
      releaseAgentRunContext(runId, liveClaim);
    }
  },
);
