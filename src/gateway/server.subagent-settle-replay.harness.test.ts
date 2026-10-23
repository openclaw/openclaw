import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildRestartRecoveryTerminalDeliveryEvidence } from "../agents/agent-command-restart-recovery.js";
import { buildAnnounceIdempotencyKey } from "../agents/announce-idempotency.js";
import { prepareCommandSessionRecoveryEntry } from "../agents/command/session-preparation.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../agents/subagents/announce/subagent-announce.requester-settle-wake.js";
import {
  mutateRequesterCompletionBatch,
  SubagentCompletionSourceChangedError,
} from "../agents/subagents/completion/subagent-completion-admission.store.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { bindSubagentRunRecord } from "../agents/subagents/registry/subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "../agents/subagents/registry/subagent-registry.store.kernel.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../config/sessions/restart-recovery-state.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  loadSessionEntryReadOnly,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import * as pendingInputs from "../config/sessions/session-accessor.pending-inputs.js";
import type { PendingInputScope } from "../config/sessions/session-pending-input-store.js";
import { resolvePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { markTestRpcSourceExecutionStarted } from "./agent-turn/rpc-source.test-support.js";
import { readUserTurnCompletionForTest } from "./pending-input-commit.test-support.js";
import * as inProcessDispatch from "./server-plugin-in-process-dispatch.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { runPublicSettleRecoveryCase } from "./server.subagent-settle-replay-recovery.test-support.js";
import { createRequesterFinalResult as finalResult } from "./server.subagent-settle-replay.test-support.js";
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
  let requesterScope: PendingInputScope & { sessionKey: string; storePath: string };
  let child: SubagentRunRecord;
  type WakeOptions = Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0];
  const provenance = (sourceSessionKey = child.childSessionKey) => ({
    kind: "inter_session" as const,
    sourceSessionKey,
    sourceChannel: "internal",
    sourceTool: "subagent_settle",
  });
  const persistedChild = () => loadSubagentRegistryFromSqlite().get(child.runId);
  const mockCommand = (run: (command: AgentCommandOpts) => Promise<void>) =>
    agentCommandMock.mockImplementationOnce(async (input) => {
      await run(input as AgentCommandOpts);
      return finalResult();
    });
  const wakeState = (batchRunIds: string[]): SubagentRunRecord["requesterSettleWake"] => ({
    status: "dispatching",
    attemptCount: 1,
    batchRunIds,
    requesterYieldBatch: true,
    afterRequesterYield: true,
    rearmGeneration: 1,
  });

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
      "agents/main/sessions/sessions.json",
    );
    requesterScope = {
      agentId: "main",
      sessionId: requesterSessionId,
      sessionKey: requesterSessionKey,
      storePath: testState.sessionStorePath,
    };
    await writeSessionStore({
      entries: { [requesterSessionKey]: { sessionId: requesterSessionId, updatedAt: Date.now() } },
    });
    agentCommandMock.mockReset();
    await prepareGatewayReplyRuntimeForTest();
    const now = Date.now();
    child = {
      runId: `settle-replay-child-${sequence}`,
      childSessionKey: `agent:main:subagent:settle-replay-child-${sequence}`,
      childAgentId: "main",
      childSessionIdentity: { sessionId: `settle-replay-child-session-${sequence}` },
      requesterSessionKey,
      requesterDisplayKey: requesterSessionKey,
      requesterAgentId: "main",
      requesterStorePath: resolvePhysicalSessionStorePath({ sessionKey: requesterSessionKey }),
      completionRequesterSessionId: requesterSessionId,
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
      // Already-delivered results still owe the explicit yield continuation.
      delivery: { status: "delivered" },
      requesterSettleWake: wakeState([`settle-replay-child-${sequence}`]),
    };
    saveChild(child);
  });

  // Restart activation arms a sweeper; retire it before the next synthetic cohort.
  afterEach(() => resetSubagentRegistryForTests({ persist: false }));

  function persistChild(entry = child) {
    writeSubagentRunValuesInDatabase(
      openOpenClawStateDatabase(),
      [bindSubagentRunRecord(entry)],
      [],
    );
  }

  function installChild(entry: SubagentRunRecord) {
    subagentRuns.set(entry.runId, entry);
    bindGatewayContextResolver(entry, kernel.gatewayRequestContext.resolveGatewayContext);
    if (entry.runId === child.runId) {
      child = entry;
    }
    return entry;
  }

  function saveChild(entry: SubagentRunRecord) {
    installChild(entry);
    persistChild(entry);
  }

  function restoreChildren(entries: SubagentRunRecord[]) {
    const restored = loadSubagentRegistryFromSqlite();
    for (const entry of entries) {
      installChild(expectDefined(restored.get(entry.runId), "Persisted subagent row"));
    }
  }

  const transitionBatch: WakeOptions["transitionBatch"] = (batch, state, onPublished) => {
    const published = batch.map((entry) => publishWake(entry, state));
    onPublished?.(published);
  };

  function publishWake(entry: SubagentRunRecord, state: SubagentRunRecord["requesterSettleWake"]) {
    const next = { ...entry, requesterSettleWake: state };
    persistChild(next);
    return installChild(next);
  }

  const assertChildCurrent = () => {
    if (subagentRuns.get(child.runId) !== child) {
      throw new SubagentCompletionSourceChangedError("Synthetic cohort was replaced");
    }
  };
  const settleWakeReplay = (sourceSessionKeys: string[]) => ({
    sourceSessionKeys,
    assertCurrent: assertChildCurrent,
  });

  const markCommandExecutionStarted = (command: AgentCommandOpts) =>
    markTestRpcSourceExecutionStarted(command, {
      storePath: testState.sessionStorePath!,
      resolveGatewayContext: kernel.gatewayRequestContext.resolveGatewayContext,
    });

  async function prepareVisibleRequesterCommand(command: AgentCommandOpts) {
    const scope = requesterScope;
    await updateSessionEntry(
      scope,
      (entry) =>
        prepareCommandSessionRecoveryEntry({
          entry,
          ...scope,
          runId: command.runId!,
          opts: command,
          now: Date.now(),
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          isSessionRollover: false,
        }).nextEntry,
    );
    return scope;
  }

  function wake(
    settledEntry = child,
    observer?: ReturnType<typeof vi.fn<WakeOptions["completeBatch"]>>,
  ) {
    const completeBatch =
      observer ??
      vi.fn<WakeOptions["completeBatch"]>(async (batch, _generation, outcome, onCommitted) => {
        expect(outcome).toBeDefined();
        await mutateRequesterCompletionBatch({
          entries: batch,
          operation: { kind: "settle", outcome: outcome! },
          assertCurrent: assertChildCurrent,
        });
        await onCommitted?.();
      });
    return {
      completeBatch,
      result: maybeWakeRequesterAfterAllChildrenSettled({
        isSourceCurrent: () => true,
        requesterSessionKey,
        settledEntry,
        transitionBatch,
        completeBatch,
      }),
    };
  }

  it.each(["success", "failure"] as const)(
    "retains real in_flight replay custody and reconciles terminal %s",
    async (outcome) => {
      const entered = createDeferred();
      const release = createDeferred();
      mockCommand(async (command) => {
        await command.userTurnTranscriptRecorder!.persistApproved();
        await markCommandExecutionStarted(command);
        entered.resolve();
        await release.promise;
        if (outcome === "failure") {
          throw new Error("isolated requester provider failure");
        }
      });
      const runId = buildAnnounceIdempotencyKey(
        `requester-settle:main:${requesterSessionKey}:${child.runId}:yield-1`,
      );
      // Prime real admission; the persisted dispatching wake must replay it.
      const original = inProcessDispatch.dispatchGatewayMethodInProcess<Record<string, unknown>>(
        "agent",
        {
          sessionKey: requesterSessionKey,
          idempotencyKey: runId,
          message: "Synthesize the isolated completed child result.",
          deliver: false,
          inputProvenance: provenance(),
        },
        {
          expectFinal: true,
          forceSyntheticClient: true,
          operatorRoleActor: { kind: "system" },
          resolveGatewayContext: kernel.gatewayRequestContext.resolveGatewayContext,
          settleWakeReplay: settleWakeReplay([child.childSessionKey]),
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
        expect(persistedChild()?.requesterSettleWake).toMatchObject({
          status: "dispatching",
          attemptCount: 1,
          rearmGeneration: 1,
        });
        expect(child.requesterSettleWake?.nextAttemptAt).toBeUndefined();
        release.resolve();
        await terminal;
        expect(agentCommandMock).toHaveBeenCalledOnce();
        const reconciliation = wake();
        expect(await reconciliation.result).toBe(outcome === "success");
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(reconciliation.completeBatch).toHaveBeenCalledOnce();
        const persisted = persistedChild();
        expect(persisted?.requesterSettleWake).toBeUndefined();
        const settled = reconciliation.completeBatch.mock.calls[0]?.[2];
        expect(settled).toMatchObject(
          outcome === "success"
            ? { delivered: true, requesterVisibleFinalDelivered: true }
            : { delivered: false, path: "direct", error: "isolated requester provider failure" },
        );
        if (outcome === "failure") {
          expect(settled?.requesterVisibleFinalDelivered).toBeUndefined();
          expect(persisted?.delivery).toEqual({ status: "delivered" });
        }
        expect(await readUserTurnCompletionForTest(requesterScope, runId)).toMatchObject({
          run_id: runId,
          outcome:
            outcome === "success"
              ? { status: "ok", reason: "completed" }
              : {
                  status: "error",
                  reason: "failed",
                  error: "isolated requester provider failure",
                },
        });
      } finally {
        release.resolve();
        await terminal;
      }
    },
  );

  it.each(["retained stale", "mixed", "legacy"] as const)(
    "scopes a saved batch's actionable recovery roster (%s)",
    async (scenario) => {
      const scope = requesterScope;
      await sessionAccessor.patchSessionEntryCore(scope, () => ({
        lifecycleRevision: "requester-before-reset",
      }));
      child.completionRequesterSessionId = requesterSessionId;
      child.completionRequesterLifecycleRevision = "requester-before-reset";
      child.execution.interruptionReason = "gateway-restart";
      child.execution.outcome = { status: "error", error: "Interrupted by Gateway restart" };
      child.cleanupCompletedAt = child.execution.endedAt;
      const visibleCompletion = (text: string): SubagentRunRecord["completion"] => ({
        required: true,
        terminalReply: { disposition: "visible", text },
        resultText: text,
      });
      child.completion = visibleCompletion(`retained result ${child.runId}`);
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
        expect(
          await maybeWakeRequesterAfterAllChildrenSettled({
            isSourceCurrent: () => true,
            requesterSessionKey,
            settledEntry: child,
            transitionBatch: vi.fn(),
            completeBatch: vi.fn(),
          }),
        ).toBe(false);
        expect(agentCommandMock).not.toHaveBeenCalled();
        // Retained history cannot acquire the reset cohort's authority.
        child = savedChild;
      }
      const cohort = [child];
      if (scenario === "mixed") {
        cohort.push({
          ...child,
          runId: `${child.runId}-current`,
          childSessionKey: `${child.childSessionKey}-current`,
          completionRequesterLifecycleRevision: loadSessionEntryReadOnly(scope)?.lifecycleRevision,
          completion: visibleCompletion("current child result"),
        });
      }
      const runIds = cohort.map((entry) => entry.runId).toSorted();
      for (const entry of cohort) {
        entry.requesterSettleWake = { ...entry.requesterSettleWake!, batchRunIds: runIds };
        persistChild(entry);
        subagentRuns.delete(entry.runId);
      }
      restoreChildren(cohort);
      mockCommand(markCommandExecutionStarted);
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
          const saved = settled.get(original.runId);
          expect(saved?.requesterSettleWake).toBeUndefined();
          expect(saved?.execution.outcome).toEqual(original.execution.outcome);
        }
      } finally {
        for (const entry of cohort) {
          subagentRuns.delete(entry.runId);
        }
      }
    },
  );

  it.each([
    "visible completed",
    "visible unconsumed completion",
    "different sibling",
    "private late descendant completed",
    "legacy completed",
    "legacy pending",
    "legacy pending revoked",
    "legacy transcript different sibling",
  ] as const)("reconciles batch identity after restart (%s)", async (trigger) => {
    const legacy = trigger.startsWith("legacy");
    const visible = trigger.startsWith("visible");
    const pending = trigger.startsWith("legacy pending");
    const transcriptOnly = trigger.startsWith("legacy transcript");
    const retryable = pending || transcriptOnly;
    const revoked = trigger === "legacy pending revoked";
    const lateDescendant = trigger === "private late descendant completed";
    if (lateDescendant) {
      const endedAt = Date.now() - 600_000;
      child = {
        ...child,
        createdAt: endedAt - 20,
        execution: { ...child.execution, startedAt: endedAt - 10, endedAt },
      };
    }
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
      if (!visible) {
        entry.completionTarget = "parent";
        entry.completionRequesterSessionId = requesterSessionId;
      }
      entry.requesterSettleWake = wakeState(batchRunIds);
      saveChild(entry);
    }
    const descendant: SubagentRunRecord | undefined = lateDescendant
      ? {
          ...child,
          runId: `${child.runId}-descendant`,
          childSessionKey: `${child.childSessionKey}-descendant`,
          requesterSessionKey: child.childSessionKey,
          completionRequesterSessionId: child.childSessionIdentity!.sessionId,
          requesterSettleWake: undefined,
          cleanupCompletedAt: undefined,
          delivery: { status: "pending" },
        }
      : undefined;
    if (descendant) {
      saveChild(descendant);
    }
    const completion = vi.fn<WakeOptions["completeBatch"]>();
    const acceptedMessages: Parameters<typeof pendingInputs.stageSessionPendingInput>[1][] = [];
    const admittedSources: Array<string | undefined> = [];
    const realStage = pendingInputs.stageSessionPendingInput;
    const observeAdmission = vi
      .spyOn(pendingInputs, "stageSessionPendingInput")
      .mockImplementation(async (scope, options) => {
        acceptedMessages.push(options);
        if (revoked && acceptedMessages.length === 2) {
          // Revoke during Gateway preparation, before SQLite admission.
          publishWake(child, {
            ...child.requesterSettleWake!,
            rearmGeneration: 2,
          });
        }
        const receipt = await realStage(scope, options);
        admittedSources.push(receipt?.message.provenance?.sourceSessionKey);
        if (transcriptOnly && acceptedMessages.length === 1 && receipt) {
          // Crash after the transcript commits, before completion persistence.
          receipt.completeAsync = async () => {
            throw new Error("isolated process exit before completion persistence");
          };
        }
        return receipt;
      });
    // Leave the wake unacknowledged after Gateway input completion commits.
    const dispatch = (entry: SubagentRunRecord) => wake(entry, completion).result;
    const originalSource = legacy ? sibling.childSessionKey : child.childSessionKey;
    mockCommand(async (command) => {
      expect(command.inputProvenance?.sourceSessionKey).toBe(originalSource);
      if (lateDescendant) {
        expect(command.message).toContain(
          "a descendant result below it was still undelivered when waiting stopped",
        );
      }
      if (pending) {
        throw new Error("isolated provider unavailable before input consumption");
      }
      const scope = visible ? await prepareVisibleRequesterCommand(command) : undefined;
      // A handled private completion can retain only its hash/outcome receipt.
      if ((!legacy || transcriptOnly) && trigger !== "visible unconsumed completion") {
        await command.userTurnTranscriptRecorder!.persistApproved();
      }
      await markCommandExecutionStarted(command);
      if (scope) {
        await updateSessionEntry(scope, (entry) =>
          buildRestartRecoveryClaimCleanupPatch({
            entry,
            recordTerminalSource: true,
            terminalRunId: command.runId,
            terminalDeliveryEvidence: buildRestartRecoveryTerminalDeliveryEvidence(finalResult()),
          }),
        );
      }
    });
    if (retryable) {
      mockCommand(async (command) => {
        expect(command.inputProvenance?.sourceSessionKey).toBe(originalSource);
        expect(command.message).toContain(`sourceSession=${originalSource}`);
        const persistence = await command.userTurnTranscriptRecorder!.persistApproved();
        if (transcriptOnly) {
          expect(persistence).toMatchObject({ appended: false });
        }
      });
    }
    // Reproduce the old sibling selection; admission and persistence stay real.
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
              { ...params, inputProvenance: provenance(sibling.childSessionKey) },
              { ...options, settleWakeReplay: undefined },
            );
          })
      : undefined;
    try {
      const firstDispatchAt = Date.now();
      const admitted = await dispatch(sibling);
      legacyDispatch?.mockRestore();
      expect(admitted).toBe(!retryable);
      if (!retryable) {
        expect(completion.mock.calls[0]?.[2]).toMatchObject({ delivered: true });
      }
      expect(agentCommandMock).toHaveBeenCalledOnce();
      const retainedWake = persistedChild()?.requesterSettleWake;
      expect(retainedWake).toMatchObject({
        status: retryable ? "pending" : "dispatching",
        attemptCount: 1,
        batchRunIds,
      });
      if (retryable) {
        expect(retainedWake?.nextAttemptAt).toBeGreaterThanOrEqual(firstDispatchAt + 30_000);
        expect(retainedWake?.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 30_000);
      } else {
        expect(retainedWake?.nextAttemptAt).toBeUndefined();
      }
      if (descendant) {
        // Changed delivery must not change the private input being reconciled.
        saveChild({ ...descendant, delivery: { status: "delivered" } });
      }
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
      // Minimal startup keeps loaded rows; explicitly rebind durable postimages.
      restoreChildren([...batch, ...(descendant ? [descendant] : [])]);
      completion.mockClear();
      if (retryable) {
        const retryAt = expectDefined(retainedWake?.nextAttemptAt, "Private retry deadline");
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(retryAt - 1);
        expect(await dispatch(child)).toBe(false);
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(completion).not.toHaveBeenCalled();
        vi.setSystemTime(retryAt);
      }
      const replayed = await dispatch(child);
      expect(replayed, child.requesterSettleWake?.lastError ?? undefined).toBe(!revoked);
      expect(agentCommandMock).toHaveBeenCalledTimes(retryable && !revoked ? 2 : 1);
      expect(admittedSources).toEqual(
        visible
          ? [child.childSessionKey]
          : revoked
            ? [originalSource]
            : [originalSource, originalSource],
      );
      if (visible) {
        expect(acceptedMessages).toHaveLength(1);
        expect(completion).toHaveBeenCalledOnce();
        expect(completion.mock.calls[0]?.[2]).toMatchObject({
          delivered: true,
          requesterVisibleFinalDelivered: true,
        });
        return;
      }
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
      expect(first!.message.provenance?.sourceSessionKey).toBe(originalSource);
      expect(replay!.message.provenance?.sourceSessionKey).toBe(child.childSessionKey);
      if (revoked) {
        expect(completion).not.toHaveBeenCalled();
        expect(persistedChild()?.requesterSettleWake).toMatchObject({
          rearmGeneration: 2,
        });
        return;
      }
      expect(completion.mock.calls[0]?.[2]).toMatchObject({ delivered: true });
    } finally {
      vi.useRealTimers();
      legacyDispatch?.mockRestore();
      observeAdmission.mockRestore();
      subagentRuns.delete(sibling.runId);
      if (descendant) {
        subagentRuns.delete(descendant.runId);
      }
    }
  });

  it.for([
    "visible final",
    "channel visible final",
    "progress only",
    "missing original authority",
    "unconsumed revoked cohort",
  ] as const)(
    "recovers public work once through a sibling and reconciles its %s",
    async (reply, { signal }) => {
      await runPublicSettleRecoveryCase(reply, signal, {
        child,
        harness,
        getKernel: () => kernel,
        requesterSessionKey,
        requesterSessionId,
        requesterScope,
        sequence,
        installChild,
        persistChild,
        start,
        wake,
        settleWakeReplay,
        prepareVisibleRequesterCommand,
        markCommandExecutionStarted,
      });
    },
  );
});
