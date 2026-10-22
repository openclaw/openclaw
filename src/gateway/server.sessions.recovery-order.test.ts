import { expect, test, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/index.js";
import { claimAgentSessionWriter } from "../agents/embedded-agent-runner/run/session-bootstrap.js";
import { commitMainSessionRecovery } from "../agents/main-session-recovery/main-session-recovery-store.js";
import { recoverStore } from "../agents/main-session-recovery/main-session-restart-recovery-store.js";
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
import { createMockGatewayRecoveryRuntime } from "./server-recovery-runtime.test-support.js";
import { seedExhaustedRecovery } from "./server.sessions.recovery.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  seedSessionTranscript,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import type { WorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test.each([
  { code: "INVALID_REQUEST", message: "missing scope: operator.write", retryable: false },
  { code: "UNAVAILABLE", message: "Gateway is restarting", retryable: true },
])("sessions.recover resumes after three rejected dispatches: $message", async (error) => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:rejected-recovery";
  const sessionId = "rejected-recovery-session";
  const target = { agentId: "main", sessionKey, storePath };
  await writeSessionStore({ entries: { [sessionKey]: { sessionId, updatedAt: 1_000 } } });
  await commitMainSessionRecovery({
    target,
    command: { kind: "mark_interrupted", cycleId: "rejected-cycle", now: 2_000 },
  });
  await seedSessionTranscript({
    ...target,
    sessionId,
    messages: [{ role: "user", content: "Finish the interrupted task." }],
  });
  const dispatchAgent = vi.fn().mockRejectedValue(new GatewayClientRequestError(error));
  const handledSessionKeys = new Set<string>();
  for (let pass = 0; pass < 3; pass++) {
    expect(
      await recoverStore({
        storeAgentId: "main",
        storePath,
        cfg: getRuntimeConfig(),
        handledSessionKeys,
        gatewayRuntime: createMockGatewayRecoveryRuntime({ dispatchAgent }),
      }),
    ).toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
  }
  expect(dispatchAgent).toHaveBeenCalledTimes(3);
  expect(loadSessionEntry(target)).toMatchObject({
    status: "interrupted",
    abortedLastRun: true,
    mainRestartRecovery: { chargedAttempts: 0 },
  });
  expect(loadSessionEntry(target)?.mainRestartRecovery?.tombstone).toBeUndefined();
  const recovered = await directSessionReq("sessions.recover", { key: sessionKey });
  expect(recovered, JSON.stringify(recovered.error)).toMatchObject({
    ok: true,
    payload: { key: sessionKey, sessionId, continuation: { status: "started" } },
  });
  expect(loadSessionEntry(target)?.archivedAt).toBeUndefined();
  expect(JSON.stringify(await loadTranscriptEvents({ ...target, sessionId }))).toContain(
    "Finish the interrupted task.",
  );
});

test.each([false, true])("queues cloud recovery (revoked=%s)", async (revokeAuthority) => {
  const { storePath } = await createSessionStoreDir();
  const sourceKey = "agent:main:dashboard:concurrent-cloud-recovery";
  const sourceSessionId = "concurrent-cloud-recovery-source";
  const source = { agentId: "main", sessionKey: sourceKey, storePath };
  await seedExhaustedRecovery({ ...source, sessionId: sourceSessionId });
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
  const recover = (options: Parameters<typeof directSessionReq<RecoveryPayload>>[2]) =>
    directSessionReq<RecoveryPayload>("sessions.recover", { key: sourceKey }, options);
  const first = recover({ context });
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
  const second = recover({
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
  }).finally(() => {
    secondSettled = true;
  });
  try {
    // Let the winner publish while any unqueued source read is still in flight.
    // Correct recovery queues before acquiring facts, so it reaches the other gate.
    await Promise.race([secondRead.promise, secondQueued.promise]);
    holdNextRead = false;
    authorityActive = !revokeAuthority;
    startReclaim.resolve();
    await reclaimed.promise;
    // The placement queue is free, but the winner has not published its successor.
    expect(secondSettled).toBe(false);
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
  expect(loadSessionEntry(source)?.mainRestartRecovery?.tombstone).toMatchObject({
    recoveredSessionKey: winner.payload?.key,
    recoveredSessionId: winner.payload?.sessionId,
  });
  expect(loadSessionEntry({ ...source, sessionKey: winner.payload!.key })).toMatchObject({
    sessionId: winner.payload?.sessionId,
    previousSessionId: sourceSessionId,
  });
});

test.each([
  { name: "admitted", status: undefined, admitted: true, live: false },
  { name: "failed", status: "failed", admitted: false, live: false },
  { name: "failed", status: "failed", admitted: false, live: true },
  { name: "statusless", status: undefined, admitted: false, live: false },
  { name: "done", status: "done", admitted: false, live: false },
  { name: "killed", status: "killed", admitted: false, live: false },
] as const)("recovers orphaned $name writers (live=$live)", async ({ status, live, admitted }) => {
  const { dir, storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:orphaned-recovery";
  const sessionId = "orphaned-recovery-session";
  const runId = "orphaned-recovery-run";
  const cycleId = "orphaned-recovery-cycle";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const target = { agentId: "main", sessionKey, storePath };
  const run = { sessionId, runId, lifecycleGeneration };
  const commit = (command: Parameters<typeof commitMainSessionRecovery>[0]["command"]) =>
    commitMainSessionRecovery({ target, command });
  await writeSessionStore({ entries: { [sessionKey]: { sessionId, updatedAt: 1_000 } } });
  await persistGatewaySessionLifecycleEvent({
    sessionKey,
    event: {
      ts: 1_000,
      ...run,
      data: { phase: "start", startedAt: 1_000 },
    },
  });
  await commit({ kind: "mark_interrupted", cycleId, now: 2_000 });
  await commit({
    kind: "prepare_attempt",
    attempt: 1,
    lifecycleGeneration,
    now: 3_000,
    observation: { sessionId, cycleId, revision: 1 },
    runId,
    executionIdentity: { state: "disabled" },
  });
  await commit({ kind: "admit_recovery", ...run, now: 3_000 });
  await commit({ kind: "register_recovery_turn", ...run, cycleId, attempt: 1 });
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
    expect([restored?.activeWriterRunId, restored?.lifecycleRunId]).not.toContain(runId);
    expect(JSON.stringify(await loadTranscriptEvents({ ...target, sessionId }))).toContain(
      "preserve this conversation",
    );
  } finally {
    releaseAgentRunContext(runId, liveClaim);
  }
});
