// Real Gateway admission/replay and SQLite settlement with controlled agent-command execution.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildRestartRecoveryTerminalDeliveryEvidence } from "../agents/agent-command-restart-recovery.js";
import { buildAnnounceIdempotencyKey } from "../agents/announce-idempotency.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import type { AgentDeliveryEvidence } from "../agents/embedded-agent-runner/delivery-evidence.js";
import { buildMainSessionRecoveryClearPatch } from "../agents/main-session-recovery/main-session-recovery-clear.js";
import { recoverRestartAbortedMainSessions } from "../agents/main-session-recovery/main-session-restart-recovery.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../agents/subagents/announce/subagent-announce.requester-settle-wake.js";
import {
  mutateRequesterCompletionBatch,
  SubagentCompletionSourceChangedError,
} from "../agents/subagents/completion/subagent-completion-admission.store.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { bindSubagentRunRecord } from "../agents/subagents/registry/subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "../agents/subagents/registry/subagent-registry.store.kernel.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { getRuntimeConfig } from "../config/config.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../config/sessions/restart-recovery-state.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  loadTranscriptEventsSync,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolvePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as inProcessDispatch from "./server-plugin-in-process-dispatch.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

describe("public yielded settle replay with real Gateway admission", () => {
  let harness: GatewayServerHarness;
  let resetClient: Awaited<ReturnType<GatewayServerHarness["openClient"]>>;
  let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
  let sequence = 0;
  let requesterSessionKey: string;
  let requesterSessionId: string;
  let child: SubagentRunRecord;

  async function start() {
    const module = await import("./server-kernel.js");
    const create = module.createGatewayKernel;
    const capture = vi.spyOn(module, "createGatewayKernel").mockImplementation(async (...args) => {
      kernel = await create(...args);
      return kernel;
    });
    try {
      harness = await startGatewayServerHarness();
      resetClient = await harness.openClient({ scopes: ["operator.admin"] });
    } finally {
      capture.mockRestore();
    }
  }
  installGatewayTestHooks({ scope: "suite", setup: start, cleanup: async () => harness?.close() });

  beforeEach(async () => {
    sequence += 1;
    requesterSessionKey = `agent:main:settle-replay-${sequence}`;
    requesterSessionId = `settle-replay-parent-${sequence}`;
    testState.sessionStorePath = path.join(
      process.env.OPENCLAW_STATE_DIR!,
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    await writeSessionStore({
      entries: { [requesterSessionKey]: { sessionId: requesterSessionId, updatedAt: Date.now() } },
    });
    agentCommandMock.mockReset();
    await prepareGatewayReplyRuntimeForTest();
    const now = Date.now();
    child = {
      runId: `settle-replay-child-${sequence}`,
      childSessionKey: `agent:main:subagent:settle-replay-child-${sequence}`,
      requesterSessionKey,
      requesterDisplayKey: requesterSessionKey,
      requesterAgentId: "main",
      requesterStorePath: resolvePhysicalSessionStorePath({ sessionKey: requesterSessionKey }),
      task: "Return the isolated child result",
      cleanup: "keep",
      createdAt: now - 30,
      execution: {
        status: "terminal",
        startedAt: now - 20,
        endedAt: now - 10,
        outcome: { status: "ok" },
      },
      expectsCompletionMessage: true,
      completion: { required: true, resultText: "isolated child result", capturedAt: now - 10 },
      // A delivered child can be included in a later yielded requester batch.
      // Its old delivery receipt does not discharge that new synthesis obligation.
      delivery: { status: "delivered" },
      requesterSettleWake: {
        status: "dispatching",
        attemptCount: 1,
        batchRunIds: [`settle-replay-child-${sequence}`],
        requesterYieldBatch: true,
        afterRequesterYield: true,
        rearmGeneration: 1,
      },
    };
    subagentRuns.set(child.runId, child);
    bindGatewayContextResolver(child, () => kernel.gatewayRequestContext);
    persistChild();
  });

  afterEach(() => {
    subagentRuns.delete(child.runId);
  });

  function persistChild(entry = child) {
    writeSubagentRunValuesInDatabase(
      openOpenClawStateDatabase(),
      [bindSubagentRunRecord(entry)],
      [],
    );
  }

  const finalResult = (): Exclude<Awaited<ReturnType<typeof agentCommandMock>>, void> => ({
    payloads: [{ text: "Requester synthesis is complete.", mediaUrl: null }],
    meta: { durationMs: 1, finalAssistantVisibleText: "Requester synthesis is complete." },
    deliveryStatus: {
      requested: true,
      attempted: true,
      succeeded: true,
      status: "sent",
      resultCount: 1,
    },
  });

  function wake(settledEntry = child) {
    const completeBatch = vi.fn<
      Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0]["completeBatch"]
    >(async (batch, _generation, outcome, onCommitted) => {
      expect(outcome).toBeDefined();
      await mutateRequesterCompletionBatch({
        entries: batch,
        operation: { kind: "settle", outcome: outcome! },
        assertCurrent: () => {
          if (subagentRuns.get(child.runId) !== child) {
            throw new SubagentCompletionSourceChangedError(
              "Subagent completion owner changed before settlement",
            );
          }
        },
      });
      onCommitted?.();
    });
    return {
      completeBatch,
      result: maybeWakeRequesterAfterAllChildrenSettled({
        isSourceCurrent: () => true,
        requesterSessionKey,
        settledEntry,
        transitionBatch: (batch, state, onPublished) => {
          for (const entry of batch) {
            entry.requesterSettleWake = state;
            persistChild(entry);
          }
          onPublished(batch);
        },
        completeBatch,
      }),
    };
  }

  it.each(["success", "failure"] as const)(
    "retains real in_flight replay custody and reconciles terminal %s",
    async (outcome) => {
      const entered = createDeferred();
      const release = createDeferred();
      agentCommandMock.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        if (outcome === "failure") {
          throw new Error("isolated requester provider failure");
        }
        return finalResult();
      });
      const runId = buildAnnounceIdempotencyKey(
        `requester-settle:main:${requesterSessionKey}:${child.runId}:yield-1`,
      );
      // Prime real admission, not a seeded dedupe entry or a mocked startTurn.
      // The persisted dispatching wake represents an observer that must replay.
      const original = inProcessDispatch.dispatchGatewayMethodInProcess<Record<string, unknown>>(
        "agent",
        {
          sessionKey: requesterSessionKey,
          idempotencyKey: runId,
          message: "Synthesize the isolated completed child result.",
          deliver: false,
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: child.childSessionKey,
            sourceChannel: "internal",
            sourceTool: "subagent_settle",
          },
        },
        {
          expectFinal: true,
          forceSyntheticClient: true,
          operatorRoleActor: { kind: "system" },
          resolveGatewayContext: () => kernel.gatewayRequestContext,
        },
      );
      // Observe rejection immediately, including if admission itself fails.
      const terminal = original.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          entered.promise,
          terminal.then((result) => {
            if ("error" in result) {
              throw result.error;
            }
          }),
        ]);
        expect(kernel.gatewayRequestContext.dedupe.get(`agent:${runId}`)?.payload).toMatchObject({
          runId,
          status: "accepted",
        });
        const replay = wake();
        expect(await replay.result).toBe(false);
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(replay.completeBatch).not.toHaveBeenCalled();
        expect(
          loadSubagentRegistryFromSqlite().get(child.runId)?.requesterSettleWake,
        ).toMatchObject({
          status: "dispatching",
          attemptCount: 1,
          rearmGeneration: 1,
        });
        const replayDueAt = child.requesterSettleWake?.nextAttemptAt;
        expect(replayDueAt).toBeGreaterThan(Date.now());
        release.resolve();
        await terminal;
        expect(agentCommandMock).toHaveBeenCalledOnce();
        // Only advance Date after original execution has settled. No Gateway
        // timers run early and the persisted owner/deadline remain unchanged.
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(replayDueAt! + 1);
        const reconciliation = wake();
        expect(await reconciliation.result).toBe(outcome === "success");
        expect(agentCommandMock).toHaveBeenCalledOnce();
        const persisted = loadSubagentRegistryFromSqlite().get(child.runId);
        if (outcome === "success") {
          expect(reconciliation.completeBatch).toHaveBeenCalledOnce();
          expect(reconciliation.completeBatch.mock.calls[0]?.[2]).toMatchObject({
            delivered: true,
            requesterVisibleFinalDelivered: true,
          });
          expect(persisted?.requesterSettleWake).toBeUndefined();
        } else {
          // A known failed turn may rotate the next attempt, but cannot silently
          // discharge the owed synthesis as delivered.
          expect(reconciliation.completeBatch).not.toHaveBeenCalled();
          expect(persisted?.requesterSettleWake).toMatchObject({
            status: "pending",
            attemptCount: 1,
            rearmGeneration: 1,
          });
          expect(persisted?.requesterSettleWake?.lastError).toBeTruthy();
        }
      } finally {
        vi.useRealTimers();
        release.resolve();
        await terminal;
      }
    },
  );

  it.each(["retained stale", "mixed", "legacy"] as const)(
    "scopes a saved batch's actionable recovery roster (%s)",
    async (scenario) => {
      const scope = { storePath: testState.sessionStorePath!, sessionKey: requesterSessionKey };
      await sessionAccessor.patchSessionEntryCore(scope, () => ({
        lifecycleRevision: "requester-before-reset",
      }));
      child.completionRequesterSessionId = requesterSessionId;
      child.completionRequesterLifecycleRevision = "requester-before-reset";
      child.execution.interruptionReason = "gateway-restart";
      child.execution.outcome = { status: "error", error: "Interrupted by Gateway restart" };
      child.cleanupCompletedAt = child.execution.endedAt;
      child.completion = { required: true, resultText: `retained result ${child.runId}` };
      if (scenario === "legacy") {
        child.completionRequesterSessionId = undefined;
        child.completionRequesterLifecycleRevision = undefined;
      }
      persistChild();
      if (scenario === "retained stale" || scenario === "mixed") {
        const savedChild = structuredClone(child);
        expect(
          (await rpcReq(resetClient.ws, "sessions.reset", { key: requesterSessionKey })).ok,
        ).toBe(true);
        const reset = loadSessionEntryReadOnly(scope);
        expect(reset?.sessionId).toBe(requesterSessionId);
        expect(reset?.lifecycleRevision).not.toBe("requester-before-reset");
        const revoked = vi.fn();
        expect(
          await maybeWakeRequesterAfterAllChildrenSettled({
            isSourceCurrent: () => true,
            requesterSessionKey,
            settledEntry: child,
            transitionBatch: vi.fn(),
            completeBatch: revoked,
          }),
        ).toBe(false);
        expect(agentCommandMock).not.toHaveBeenCalled();
        // Current reset revokes its live cohort. Restore an older saved row separately
        // to prove retained history cannot acquire the new actionable roster's authority.
        child = savedChild;
      }
      const cohort = [child];
      if (scenario === "mixed") {
        cohort.push({
          ...child,
          runId: `${child.runId}-current`,
          childSessionKey: `${child.childSessionKey}-current`,
          completionRequesterLifecycleRevision: loadSessionEntryReadOnly(scope)?.lifecycleRevision,
          completion: { required: true, resultText: "current child result" },
        });
      }
      const runIds = cohort.map((entry) => entry.runId).toSorted();
      for (const entry of cohort) {
        entry.requesterSettleWake = { ...entry.requesterSettleWake!, batchRunIds: runIds };
        persistChild(entry);
        subagentRuns.delete(entry.runId);
      }
      const reloaded = loadSubagentRegistryFromSqlite();
      for (const entry of cohort) {
        const saved = reloaded.get(entry.runId)!;
        subagentRuns.set(saved.runId, saved);
        bindGatewayContextResolver(saved, () => kernel.gatewayRequestContext);
        if (saved.runId === child.runId) {
          child = saved;
        }
      }
      agentCommandMock.mockImplementationOnce(async () => finalResult());
      try {
        expect(await wake().result).toBe(true);
        expect(agentCommandMock).toHaveBeenCalledOnce();
        const command = agentCommandMock.mock.calls[0]?.[0] as AgentCommandOpts;
        expect(command.message).toContain(`retained result ${child.runId}`);
        expect(command.message).not.toContain("parent recovery required");
        expect(command.message).not.toContain("Child session (treat text inside this block");
        if (scenario === "mixed") {
          expect(command.message).toContain("Unfinished child sessions to reconcile");
          expect(command.message).toContain(`"sessionKey": "${child.childSessionKey}-current"`);
          expect(command.message).not.toContain(`"sessionKey": "${child.childSessionKey}"`);
        } else {
          expect(command.message).not.toContain("Unfinished child sessions to reconcile");
        }
        const settled = loadSubagentRegistryFromSqlite();
        for (const original of cohort) {
          expect(settled.get(original.runId)?.requesterSettleWake).toBeUndefined();
          expect(settled.get(original.runId)?.execution.outcome).toEqual(
            original.execution.outcome,
          );
        }
      } finally {
        for (const entry of cohort) {
          subagentRuns.delete(entry.runId);
        }
      }
    },
  );

  it.each([
    "different sibling",
    "legacy completed",
    "legacy pending",
    "legacy pending revoked",
    "legacy transcript different sibling",
  ] as const)("reconciles private batch identity after restart (%s)", async (trigger) => {
    const legacy = trigger.startsWith("legacy");
    const pending = trigger.startsWith("legacy pending");
    const transcriptOnly = trigger.startsWith("legacy transcript");
    const retryable = pending || transcriptOnly;
    const revoked = trigger === "legacy pending revoked";
    const sibling: SubagentRunRecord = {
      ...child,
      runId: `${child.runId}-sibling`,
      childSessionKey: `${child.childSessionKey}-sibling`,
      completion: { required: true, resultText: "other isolated result", capturedAt: Date.now() },
    };
    const batch = [child, sibling];
    const batchRunIds = batch.map((entry) => entry.runId).toSorted();
    for (const entry of batch) {
      entry.cleanupCompletedAt = Date.now();
      entry.completionTarget = "parent";
      entry.completionRequesterSessionId = requesterSessionId;
      entry.requesterSettleWake = {
        status: "dispatching",
        attemptCount: 1,
        batchRunIds,
        requesterYieldBatch: true,
        afterRequesterYield: true,
        rearmGeneration: 1,
      };
      subagentRuns.set(entry.runId, entry);
      bindGatewayContextResolver(entry, () => kernel.gatewayRequestContext);
      persistChild(entry);
    }
    const completion = vi.fn();
    const acceptedMessages: Parameters<typeof sessionAccessor.stageSessionPendingInput>[1][] = [];
    const admittedSources: Array<string | undefined> = [];
    const realStage = sessionAccessor.stageSessionPendingInput;
    const observeAdmission = vi
      .spyOn(sessionAccessor, "stageSessionPendingInput")
      .mockImplementation(async (scope, options) => {
        acceptedMessages.push(options);
        if (revoked && acceptedMessages.length === 2) {
          // A newer yield revokes the frozen wave during asynchronous
          // Gateway preparation, before the real SQLite owner admits it.
          child.requesterSettleWake = {
            ...child.requesterSettleWake!,
            rearmGeneration: 2,
          };
          persistChild();
        }
        const receipt = await realStage(scope, options);
        admittedSources.push(receipt?.message.provenance?.sourceSessionKey);
        if (transcriptOnly && acceptedMessages.length === 1 && receipt) {
          // Leave the real committed transcript as the only durable evidence,
          // as when the process exits before the completion write is admitted.
          receipt.completeAsync = async () => {
            throw new Error("isolated process exit before completion persistence");
          };
        }
        return receipt;
      });
    const dispatch = (settledEntry: SubagentRunRecord) =>
      maybeWakeRequesterAfterAllChildrenSettled({
        isSourceCurrent: () => true,
        requesterSessionKey,
        settledEntry,
        transitionBatch: (members, state, onPublished) => {
          for (const entry of members) {
            entry.requesterSettleWake = state;
            persistChild(entry);
          }
          onPublished(members);
        },
        // Model the crash window after Gateway input completion commits but
        // before lifecycle durably acknowledges the dispatching wake.
        completeBatch: completion,
      });
    agentCommandMock.mockImplementationOnce(async (input) => {
      const command = input as AgentCommandOpts;
      expect(command.inputProvenance?.sourceSessionKey).toBe(
        legacy ? sibling.childSessionKey : child.childSessionKey,
      );
      if (pending) {
        throw new Error("isolated provider unavailable before input consumption");
      }
      // A handled private completion can retain only its hash/outcome receipt.
      if (!legacy || transcriptOnly) {
        await command.userTurnTranscriptRecorder!.persistApproved();
      }
      command.onExecutionStarted?.();
      return finalResult();
    });
    if (retryable) {
      agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        expect(command.inputProvenance?.sourceSessionKey).toBe(sibling.childSessionKey);
        expect(command.message).toContain(`sourceSession=${sibling.childSessionKey}`);
        const persistence = await command.userTurnTranscriptRecorder!.persistApproved();
        if (transcriptOnly) {
          expect(persistence).toMatchObject({ appended: false });
        }
        return finalResult();
      });
    }
    // Reproduce the published producer, which selected the scheduling sibling.
    // Admission, request hashing, receipt persistence, and execution stay real.
    const originalDispatch = inProcessDispatch.dispatchGatewayMethodInProcess;
    let replayedLegacyAgent = false;
    const legacyDispatch = legacy
      ? vi
          .spyOn(inProcessDispatch, "dispatchGatewayMethodInProcess")
          .mockImplementation((method, params, options) => {
            if (method !== "agent" || replayedLegacyAgent) {
              return originalDispatch(method, params, options);
            }
            replayedLegacyAgent = true;
            return originalDispatch(
              method,
              {
                ...params,
                inputProvenance: {
                  kind: "inter_session",
                  sourceTool: "subagent_settle",
                  sourceChannel: "internal",
                  sourceSessionKey: sibling.childSessionKey,
                },
              },
              { ...options, settleWakeReplay: undefined },
            );
          })
      : undefined;
    try {
      const admitted = await dispatch(sibling);
      legacyDispatch?.mockRestore();
      expect(admitted).toBe(!retryable);
      if (!retryable) {
        expect(completion.mock.calls[0]?.[2]).toMatchObject({ delivered: true });
      }
      expect(agentCommandMock).toHaveBeenCalledOnce();
      expect(loadSubagentRegistryFromSqlite().get(child.runId)?.requesterSettleWake).toMatchObject({
        status: retryable ? "pending" : "dispatching",
        attemptCount: 1,
        batchRunIds,
      });
      const replayDueAt = child.requesterSettleWake?.nextAttemptAt;
      const priorDedupe = kernel.gatewayRequestContext.dedupe;
      await harness.server.close({
        reason: "gateway restart",
        restartExpectedMs: 0,
        drainTimeoutMs: 0,
      });
      closeOpenClawAgentDatabasesForTest();
      await start();
      await prepareGatewayReplyRuntimeForTest({ force: true });
      expect(kernel.gatewayRequestContext.dedupe).not.toBe(priorDedupe);
      for (const entry of batch) {
        bindGatewayContextResolver(entry, () => kernel.gatewayRequestContext);
      }
      if (replayDueAt) {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(replayDueAt + 1);
      }
      completion.mockClear();
      const replayed = await dispatch(child);
      expect(acceptedMessages).toHaveLength(2);
      const [first, replay] = acceptedMessages;
      expect(first!.runId).toBe(replay!.runId);
      const stable = (message: (typeof acceptedMessages)[number]["message"]) => {
        const { timestamp: _timestamp, ...rest } = message;
        return {
          ...rest,
          provenance: { ...rest.provenance, sourceSessionKey: "<batch-source>" },
        };
      };
      expect(stable(first!.message)).toEqual(stable(replay!.message));
      const originalSource = legacy ? sibling.childSessionKey : child.childSessionKey;
      expect(first!.message.provenance?.sourceSessionKey).toBe(originalSource);
      expect(replay!.message.provenance?.sourceSessionKey).toBe(child.childSessionKey);
      if (revoked) {
        expect(replayed).toBe(false);
        expect(admittedSources).toEqual([originalSource]);
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(completion).not.toHaveBeenCalled();
        expect(
          loadSubagentRegistryFromSqlite().get(child.runId)?.requesterSettleWake,
        ).toMatchObject({
          rearmGeneration: 2,
        });
        return;
      }
      expect(admittedSources).toEqual([originalSource, originalSource]);
      expect(replayed).toBe(true);
      expect(agentCommandMock).toHaveBeenCalledTimes(retryable ? 2 : 1);
      expect(completion.mock.calls[0]?.[2]).toMatchObject({ delivered: true });
    } finally {
      vi.useRealTimers();
      legacyDispatch?.mockRestore();
      observeAdmission.mockRestore();
      subagentRuns.delete(sibling.runId);
    }
  });

  it.for(["visible final", "progress only"] as const)(
    "recovers public work once through a sibling and reconciles its %s",
    async (reply, { signal }) => {
      const sibling = {
        ...child,
        runId: `${child.runId}-public-sibling`,
        childSessionKey: `${child.childSessionKey}-public-sibling`,
      };
      const batchRunIds = [child.runId, sibling.runId].toSorted();
      for (const entry of [child, sibling]) {
        entry.cleanupCompletedAt = Date.now();
        entry.requesterSettleWake = { ...child.requesterSettleWake!, batchRunIds };
        subagentRuns.set(entry.runId, entry);
        bindGatewayContextResolver(entry, () => kernel.gatewayRequestContext);
        persistChild(entry);
      }
      const working = createDeferred();
      const interruptedRelease = createDeferred();
      const resumed = createDeferred();
      const resumedRelease = createDeferred();
      let recoveryRunId: string | undefined;
      const scope = {
        agentId: "main",
        sessionId: requesterSessionId,
        sessionKey: requesterSessionKey,
        storePath: testState.sessionStorePath!,
      };
      const runId = buildAnnounceIdempotencyKey(
        `requester-settle:main:${requesterSessionKey}:${batchRunIds.join(",")}:yield-1`,
      );
      const release = () => {
        interruptedRelease.resolve();
        resumedRelease.resolve();
      };
      signal.addEventListener("abort", release, { once: true });
      agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        await command.userTurnTranscriptRecorder!.persistApproved();
        command.onExecutionStarted?.();
        await appendTranscriptMessage(scope, {
          cwd: process.env.OPENCLAW_STATE_DIR!,
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "verify-work", name: "exec", arguments: {} }],
            stopReason: "toolUse",
          },
        });
        await appendTranscriptMessage(scope, {
          cwd: process.env.OPENCLAW_STATE_DIR!,
          message: {
            role: "toolResult",
            toolCallId: "verify-work",
            toolName: "exec",
            content: [{ type: "text", text: "Changes verified; the requested landing remains." }],
            isError: false,
          },
        });
        command.abortSignal!.addEventListener("abort", () => interruptedRelease.resolve(), {
          once: true,
        });
        working.resolve();
        await interruptedRelease.promise;
        command.abortSignal!.throwIfAborted();
        throw new Error("the Gateway restart must interrupt unfinished work");
      });
      const original = inProcessDispatch
        .dispatchGatewayMethodInProcess<Record<string, unknown>>(
          "agent",
          {
            sessionKey: requesterSessionKey,
            idempotencyKey: runId,
            message: "Review the child result, finish verification, and land the requested change.",
            deliver: false,
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: child.childSessionKey,
              sourceChannel: "internal",
              sourceTool: "subagent_settle",
            },
          },
          {
            expectFinal: true,
            forceSyntheticClient: true,
            operatorRoleActor: { kind: "system" },
            resolveGatewayContext: () => kernel.gatewayRequestContext,
          },
        )
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      let recovery: ReturnType<typeof recoverRestartAbortedMainSessions> | undefined;
      try {
        await Promise.race([
          working.promise,
          original.then((result) => {
            if ("error" in result) {
              throw result.error;
            }
          }),
        ]);
        const priorDedupe = kernel.gatewayRequestContext.dedupe;
        expect(priorDedupe.get(`agent:${runId}`)?.payload).toMatchObject({ status: "accepted" });
        await harness.server.close({
          reason: "gateway restart",
          restartExpectedMs: 0,
          drainTimeoutMs: 0,
        });
        await original;
        expect(loadSessionEntryReadOnly(scope)).toMatchObject({
          status: "interrupted",
          abortedLastRun: true,
          restartRecoveryRuns: [expect.objectContaining({ runId })],
        });
        closeOpenClawAgentDatabasesForTest();
        await start();
        await prepareGatewayReplyRuntimeForTest({ force: true });
        for (const entry of [child, sibling]) {
          bindGatewayContextResolver(entry, () => kernel.gatewayRequestContext);
        }
        expect(kernel.gatewayRequestContext.dedupe).not.toBe(priorDedupe);
        agentCommandMock.mockImplementationOnce(async (input) => {
          const command = input as AgentCommandOpts;
          expect(command.sessionId).toBe(requesterSessionId);
          expect(command.runId).not.toBe(runId);
          recoveryRunId = command.runId;
          expect(command.message).toContain("restart");
          expect(JSON.stringify(loadTranscriptEventsSync(scope))).toContain(
            "Changes verified; the requested landing remains.",
          );
          command.onExecutionStarted?.();
          resumed.resolve();
          await resumedRelease.promise;
          const rawEvidence: AgentDeliveryEvidence =
            reply === "visible final"
              ? finalResult()
              : {
                  payloads: [{ text: "Still checking the change.", isCommentary: true }],
                };
          // The controlled command uses the same durable final projection and
          // claim cleanup as real command finalization; Gateway admission stays real.
          await updateSessionEntry(scope, (entry) => ({
            ...buildRestartRecoveryClaimCleanupPatch({
              entry,
              recordTerminalSource: true,
              terminalRunId: command.runId,
              terminalDeliveryEvidence: buildRestartRecoveryTerminalDeliveryEvidence(rawEvidence),
            }),
            ...buildMainSessionRecoveryClearPatch(entry),
            status: "done",
            endedAt: Date.now(),
          }));
          return reply === "visible final"
            ? finalResult()
            : { payloads: [], meta: { durationMs: 1 } };
        });
        recovery = recoverRestartAbortedMainSessions({
          cfg: getRuntimeConfig(),
          stateDir: process.env.OPENCLAW_STATE_DIR!,
          gatewayRuntime: kernel.gatewayInstanceRuntime.recovery,
        });
        await Promise.race([
          resumed.promise,
          recovery.then((result) => expect(result).toMatchObject({ started: 1, failed: 0 })),
        ]);
        expect(agentCommandMock).toHaveBeenCalledTimes(2);
        const pendingReplay = wake(sibling);
        expect(await pendingReplay.result).toBe(false);
        expect(pendingReplay.completeBatch).not.toHaveBeenCalled();
        expect(agentCommandMock).toHaveBeenCalledTimes(2);
        // Let the real recovery owner settle its startup admission before the
        // controlled command publishes its synthetic terminal claim cleanup.
        await expect(recovery).resolves.toMatchObject({ started: 1, failed: 0 });
        resumedRelease.resolve();
        expect(recoveryRunId).toBeDefined();
        await expect(
          kernel.gatewayInstanceRuntime.recovery.waitForAgent({
            runId: recoveryRunId!,
            timeoutMs: 5_000,
          }),
        ).resolves.toMatchObject({ status: "ok" });
        const nextAttemptAt = child.requesterSettleWake?.nextAttemptAt;
        expect(nextAttemptAt).toBeGreaterThan(Date.now());
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(nextAttemptAt! + 1);
        // Restart removed the old Gateway's dedupe cache. The already-admitted
        // settle batch must recognize its completed successor instead of rerunning.
        const completedReplay = wake(sibling);
        expect(await completedReplay.result).toBe(reply === "visible final");
        expect(agentCommandMock).toHaveBeenCalledTimes(2);
        const persistedWake = loadSubagentRegistryFromSqlite().get(
          child.runId,
        )?.requesterSettleWake;
        if (reply === "visible final") {
          expect(completedReplay.completeBatch.mock.calls[0]?.[2]).toMatchObject({
            delivered: true,
            requesterVisibleFinalDelivered: true,
          });
          expect(persistedWake).toBeUndefined();
        } else {
          expect(completedReplay.completeBatch).not.toHaveBeenCalled();
          expect(persistedWake).toMatchObject({
            status: "pending",
            attemptCount: 1,
            lastError: "completion agent did not produce a visible reply",
          });
          expect(persistedWake?.nextAttemptAt).toBeGreaterThan(Date.now());
        }
      } finally {
        vi.useRealTimers();
        release();
        await Promise.allSettled([original, recovery]);
        signal.removeEventListener("abort", release);
        subagentRuns.delete(sibling.runId);
      }
    },
  );
});
