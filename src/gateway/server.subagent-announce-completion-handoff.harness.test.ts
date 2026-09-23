// Real Gateway admission proof for public completion announces: same-key
// in_flight is not credited delivered, retained handoff rejoins instead of
// steering into a successor, and registry delivery custody settles through
// success, terminal failure/abort, and announce-deadline expiry.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../agents/announce-idempotency.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { createTaskCompletionEvent } from "../agents/subagent-test-fixtures.test-helpers.js";
import {
  clearRetainedCompletionHandoffKeysForTest,
  shouldPreferOriginalCompletionHandoff,
} from "../agents/subagents/announce/subagent-announce-completion-handoff-retention.js";
import {
  deliverSubagentAnnouncement,
  testing as announceTesting,
} from "../agents/subagents/announce/subagent-announce-delivery.test-support.js";
import type { SubagentAnnounceDeliveryResult } from "../agents/subagents/announce/subagent-announce-dispatch.js";
import { ensureDeliveryState } from "../agents/subagents/registry/subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "../agents/subagents/registry/subagent-lifecycle-events.js";
import { ANNOUNCE_COMPLETION_HARD_EXPIRY_MS } from "../agents/subagents/registry/subagent-registry-helpers.js";
import {
  markPendingFinalDelivery,
  recordAnnounceDeliveryResult,
} from "../agents/subagents/registry/subagent-registry-lifecycle-delivery.js";
import { SubagentLifecycleController } from "../agents/subagents/registry/subagent-registry-lifecycle.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
} from "../agents/subagents/registry/subagent-registry-state.js";
import {
  getSubagentRunByRunId,
  registerSubagentRun,
} from "../agents/subagents/registry/subagent-registry.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
} from "../process/gateway-work-admission.js";
import { completeTaskRunByRunId, createRunningTaskRun } from "../tasks/detached-task-runtime.js";
import { createSubagentTaskBackingDetail } from "../tasks/task-backing-authority.js";
import { findTaskByRunId } from "../tasks/task-executor.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

describe("public completion handoff real Gateway admission", () => {
  let harness: GatewayServerHarness;
  let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
  let sequence = 0;
  let requesterSessionKey: string;
  let requesterSessionId: string;
  let childSessionKey: string;
  let childRunId: string;
  let handoffKey: string;
  let storePath: string;
  let steer: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;
  let releaseHeldTurn: (() => void) | undefined;
  let pendingOriginal: Promise<unknown> | undefined;

  async function start() {
    const module = await import("./server-kernel.js");
    const create = module.createGatewayKernel;
    const capture = vi.spyOn(module, "createGatewayKernel").mockImplementation(async (...args) => {
      kernel = await create(...args);
      return kernel;
    });
    try {
      harness = await startGatewayServerHarness();
    } finally {
      capture.mockRestore();
    }
  }

  installGatewayTestHooks({ scope: "suite", setup: start, cleanup: async () => harness?.close() });

  function installAnnounceDeps(params?: {
    requesterSessionActivity?: () => {
      sessionId?: string;
      runId?: string;
      isActive: boolean;
    };
  }) {
    announceTesting.setDepsForTest({
      getRequesterSessionActivity:
        params?.requesterSessionActivity ??
        (() => ({
          sessionId: requesterSessionId,
          isActive: false,
        })),
      getRuntimeConfig: () => ({}) as never,
      sendMessage: sendMessage as never,
      queueEmbeddedAgentMessageWithOutcome: steer as never,
    });
  }

  beforeEach(async () => {
    sequence += 1;
    requesterSessionKey = `agent:main:slack:channel:C-handoff-${sequence}`;
    requesterSessionId = `requester-session-handoff-${sequence}`;
    childRunId = `child-handoff-${sequence}`;
    childSessionKey = `agent:main:subagent:${childRunId}`;
    handoffKey = buildAnnounceIdempotencyKey(
      buildAnnounceIdFromChildRun({ childSessionKey, childRunId }),
    );
    storePath = path.join(
      process.env.OPENCLAW_STATE_DIR!,
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    testState.sessionStorePath = storePath;
    await writeSessionStore({
      entries: {
        [requesterSessionKey]: { sessionId: requesterSessionId, updatedAt: Date.now() },
      },
    });
    await writeSubagentSessionEntry({
      stateDir: process.env.OPENCLAW_STATE_DIR!,
      agentId: "main",
      sessionKey: childSessionKey,
      defaultSessionId: `${childRunId}-session`,
    });
    clearRetainedCompletionHandoffKeysForTest();
    steer = vi.fn(async () => ({
      queued: true as const,
      enqueuedAtMs: Date.now(),
      deliveredAtMs: Date.now(),
    }));
    sendMessage = vi.fn(async () => ({
      channel: "slack",
      to: "channel:C-handoff",
      via: "direct" as const,
      mediaUrl: null,
      result: { messageId: "msg-handoff" },
    }));
    installAnnounceDeps();
    agentCommandMock.mockReset();
    await prepareGatewayReplyRuntimeForTest();
  });

  afterEach(async () => {
    releaseHeldTurn?.();
    releaseHeldTurn = undefined;
    if (pendingOriginal) {
      try {
        await pendingOriginal;
      } catch {
        // failure-path tests may still reject the original turn
      }
      pendingOriginal = undefined;
    }
    announceTesting.setDepsForTest();
    clearRetainedCompletionHandoffKeysForTest();
    // Do not assert gateway root drain here — leftover ws:agent.wait races the
    // suite hook. Tests that need a clean registry call settle explicitly.
    await vi.dynamicImportSettled();
  });

  function agentParams(message: string) {
    return {
      sessionKey: requesterSessionKey,
      message,
      deliver: true,
      bestEffortDeliver: true,
      idempotencyKey: handoffKey,
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "subagent_announce",
        sourceSessionKey: childSessionKey,
      },
    };
  }

  function announce() {
    return deliverSubagentAnnouncement({
      requesterSessionKey,
      targetRequesterSessionKey: requesterSessionKey,
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterSessionOrigin: {
        channel: "slack",
        to: "channel:C-handoff",
        accountId: "acct-1",
      },
      completionDirectOrigin: {
        channel: "slack",
        to: "channel:C-handoff",
        accountId: "acct-1",
      },
      directOrigin: {
        channel: "slack",
        to: "channel:C-handoff",
        accountId: "acct-1",
      },
      requesterIsSubagent: false,
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
      directIdempotencyKey: handoffKey,
      sourceRunId: childRunId,
      sourceSessionKey: childSessionKey,
      sourceTool: "sessions_spawn",
      internalEvents: [
        createTaskCompletionEvent({
          childSessionKey,
          childSessionId: `${childRunId}-session`,
          taskLabel: "handoff proof",
          status: "ok",
          result: "The delegated task is complete.",
        }),
      ],
      resolveGatewayContext: () => kernel.gatewayRequestContext,
    });
  }

  function requireChildRun(): SubagentRunRecord {
    const entry = getSubagentRunByRunId(childRunId);
    expect(entry, "child registry row").toBeDefined();
    return entry!;
  }

  function persistChildCustody() {
    persistSubagentRunsToDisk(subagentRuns, [childRunId]);
  }

  function settleAnnounceCustody(delivery: SubagentAnnounceDeliveryResult) {
    const entry = requireChildRun();
    recordAnnounceDeliveryResult(entry, delivery, subagentRuns);
    if (delivery.delivered) {
      const deliveryState = ensureDeliveryState(entry);
      deliveryState.status = "delivered";
      deliveryState.announcedAt = deliveryState.deliveredAt ?? Date.now();
    } else {
      markPendingFinalDelivery({
        entry,
        error: delivery.error ?? delivery.reason,
      });
    }
    persistChildCustody();
  }

  function expectRegistryCustody(expected: Record<string, unknown>) {
    expect(getSubagentRunByRunId(childRunId)?.delivery).toMatchObject(expected);
    expect(loadSubagentRegistryFromSqlite().get(childRunId)?.delivery).toMatchObject(expected);
  }

  async function expectRegistryCustodyAfterReload(expected: Record<string, unknown>) {
    // Flush microtasks, then prove live + on-disk custody. Do not re-init the
    // registry against the live Gateway here: init resumes pending/suspended
    // rows via agent.wait. SQLite load is the persistence proof; hard drain
    // below ends any resume wait so zero-root settle can pass.
    await vi.dynamicImportSettled();
    expectRegistryCustody(expected);
    expect(loadSubagentRegistryFromSqlite().get(childRunId)?.delivery).toMatchObject(expected);
  }

  async function drainGatewayRootsForTest() {
    // Hard settle: resume waits end when their run lifecycle ends. Emit end for
    // the child and the retained handoff key so ws:agent.wait releases, then
    // wait out follow-on cleanup roots without re-init / soft flush.
    await vi.dynamicImportSettled();
    for (let i = 0; i < 5 && getActiveGatewayRootWorkCount() > 0; i++) {
      const holders = getActiveGatewayRootWorkHolders();
      if (holders.some((h) => h.includes("agent.wait"))) {
        for (const runId of [childRunId, handoffKey]) {
          emitAgentEvent({
            runId,
            stream: "lifecycle",
            data: { phase: "end", endedAt: Date.now(), aborted: true, stopReason: "aborted" },
          });
        }
      }
      await vi.dynamicImportSettled();
    }
    await vi.waitFor(
      () => {
        expect(
          getActiveGatewayRootWorkCount(),
          `residual registry roots: ${getActiveGatewayRootWorkHolders().join(", ") || "unattributed"}`,
        ).toBe(0);
      },
      { timeout: 15_000 },
    );
  }

  function registerChildRun(task: string) {
    registerSubagentRun({
      runId: childRunId,
      childSessionKey,
      requesterSessionKey,
      requesterDisplayKey: requesterSessionKey,
      task,
      cleanup: "keep",
      expectsCompletionMessage: true,
      spawnMode: "run",
    });
  }

  function holdOriginalTurn(params: { fail?: boolean; message: string }) {
    const held = createDeferred();
    const release = createDeferred();
    releaseHeldTurn = () => release.resolve();
    agentCommandMock.mockImplementationOnce(async (input: unknown) => {
      const command = input as AgentCommandOpts;
      command.onExecutionStarted?.();
      held.resolve();
      await release.promise;
      if (params.fail) {
        throw new Error("original handoff execution failed");
      }
      return {
        payloads: [{ text: "The delegated task is complete." }],
        meta: { durationMs: 1 },
        deliverySucceeded: true,
        deliveryStatus: {
          requested: true,
          attempted: true,
          status: "sent",
          succeeded: true,
          resultCount: 1,
        },
      } as never;
    });
    const original = dispatchGatewayMethodInProcess<Record<string, unknown>>(
      "agent",
      agentParams(params.message),
      {
        expectFinal: true,
        forceSyntheticClient: true,
        operatorRoleActor: { kind: "system" },
        resolveGatewayContext: () => kernel.gatewayRequestContext,
      },
    );
    pendingOriginal = original;
    return { held, original };
  }

  function activateSuccessorRequester() {
    installAnnounceDeps({
      requesterSessionActivity: () => ({
        sessionId: requesterSessionId,
        runId: "successor-requester-run",
        isActive: true,
      }),
    });
  }

  function expectNoDuplicateFallback() {
    expect(steer).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  }

  function expectPendingHandoff(result: SubagentAnnounceDeliveryResult) {
    expect(result).toMatchObject({
      delivered: false,
      path: "direct",
      reason: "completion_handoff_pending",
      disposition: "retryable",
      terminal: true,
    });
    expect(shouldPreferOriginalCompletionHandoff({ directIdempotencyKey: handoffKey })).toBe(true);
  }

  it(
    "keeps same-key in_flight undelivered, rejoins under successor activity, and settles registry",
    { timeout: 30_000 },
    async () => {
      registerChildRun("handoff proof");
      await settleSubagentRegistryPersistenceWork();
      expectRegistryCustody({ status: "pending" });

      const { held, original } = holdOriginalTurn({ message: "original completion handoff" });
      await held.promise;

      const pending = await announce();
      expectPendingHandoff(pending);
      settleAnnounceCustody(pending);
      expectRegistryCustody({
        status: "pending",
        disposition: "retryable",
      });

      activateSuccessorRequester();
      const rejoined = await announce();
      expectPendingHandoff(rejoined);
      expectNoDuplicateFallback();
      settleAnnounceCustody(rejoined);
      expectRegistryCustody({
        status: "pending",
        disposition: "retryable",
      });

      releaseHeldTurn?.();
      releaseHeldTurn = undefined;
      const terminal = await original;
      expect(terminal).toMatchObject({ runId: handoffKey, status: "ok" });
      pendingOriginal = undefined;

      const settled = await announce();
      expect(settled).toMatchObject({
        delivered: true,
        path: "direct",
      });
      expectNoDuplicateFallback();
      expect(shouldPreferOriginalCompletionHandoff({ directIdempotencyKey: handoffKey })).toBe(
        false,
      );
      settleAnnounceCustody(settled);
      await expectRegistryCustodyAfterReload({
        status: "delivered",
        disposition: "delivered",
        deliveredAt: expect.any(Number),
      });
      await drainGatewayRootsForTest();
    },
  );

  it(
    "keeps retained handoff and pending custody when the original Gateway turn fails",
    { timeout: 30_000 },
    async () => {
      registerChildRun("handoff failure proof");
      await settleSubagentRegistryPersistenceWork();
      expectRegistryCustody({ status: "pending" });

      const { held, original } = holdOriginalTurn({
        fail: true,
        message: "failed completion handoff",
      });
      await held.promise;
      const pending = await announce();
      expectPendingHandoff(pending);
      settleAnnounceCustody(pending);
      expectRegistryCustody({
        status: "pending",
        disposition: "retryable",
      });

      releaseHeldTurn?.();
      releaseHeldTurn = undefined;
      await expect(original).rejects.toThrow(/original handoff execution failed/);
      pendingOriginal = undefined;
      await vi.dynamicImportSettled();

      activateSuccessorRequester();
      const failedReplay = await announce();
      expect(failedReplay).toMatchObject({
        delivered: false,
        path: "direct",
        disposition: "retryable",
        terminal: true,
      });
      expectNoDuplicateFallback();
      expect(shouldPreferOriginalCompletionHandoff({ directIdempotencyKey: handoffKey })).toBe(
        true,
      );
      settleAnnounceCustody(failedReplay);
      await expectRegistryCustodyAfterReload({
        status: "pending",
        disposition: "retryable",
        lastError: failedReplay.error ?? failedReplay.reason,
      });
      await drainGatewayRootsForTest();
      expect(getSubagentRunByRunId(childRunId)?.delivery?.status).not.toBe("delivered");
      expect(loadSubagentRegistryFromSqlite().get(childRunId)?.delivery?.status).not.toBe(
        "delivered",
      );
      expectNoDuplicateFallback();
    },
  );

  it(
    "suspends pending retained custody on announce deadline expiry without successor steer",
    { timeout: 30_000 },
    async () => {
      registerChildRun("handoff expiry proof");
      await settleSubagentRegistryPersistenceWork();
      expectRegistryCustody({ status: "pending" });

      const { held, original } = holdOriginalTurn({ message: "expiring completion handoff" });
      await held.promise;
      const pending = await announce();
      expectPendingHandoff(pending);
      settleAnnounceCustody(pending);
      expectRegistryCustody({
        status: "pending",
        disposition: "retryable",
      });

      const startedAt = Date.now() - ANNOUNCE_COMPLETION_HARD_EXPIRY_MS - 2_000;
      const endedAt = Date.now() - ANNOUNCE_COMPLETION_HARD_EXPIRY_MS - 1_000;
      const task = createRunningTaskRun({
        runtime: "subagent",
        sourceId: childRunId,
        runId: childRunId,
        ownerKey: requesterSessionKey,
        scopeKind: "session",
        childSessionKey,
        task: "handoff expiry proof",
        startedAt,
        lastEventAt: startedAt,
        deliveryStatus: "pending",
        detail: createSubagentTaskBackingDetail(1),
      });
      expect(task).not.toBeNull();
      completeTaskRunByRunId({
        runId: childRunId,
        runtime: "subagent",
        sessionKey: childSessionKey,
        endedAt,
        lastEventAt: endedAt,
        terminalOutcome: "succeeded",
        suppressDelivery: true,
      });

      const entry = requireChildRun();
      entry.endedReason = SUBAGENT_ENDED_REASON_COMPLETE;
      entry.execution = {
        ...entry.execution,
        status: "terminal",
        startedAt,
        endedAt,
        outcome: { status: "ok" },
      };
      const delivery = ensureDeliveryState(entry);
      delivery.windowStartedAt = endedAt;
      delivery.deadlineAt = endedAt + ANNOUNCE_COMPLETION_HARD_EXPIRY_MS;
      persistChildCustody();

      activateSuccessorRequester();
      const expiryController = new SubagentLifecycleController({
        runs: subagentRuns,
        resumedRuns: new Set(),
        subagentAnnounceTimeoutMs: 1_000,
        getRuntimeConfig: () => ({}) as never,
        persist: (...runIds) => persistSubagentRunsToDisk(subagentRuns, runIds),
        persistOrThrow: (...runIds) => persistSubagentRunsToDiskOrThrow(subagentRuns, runIds),
        clearPendingLifecycleError: () => {},
        countPendingDescendantRuns: () => 0,
        getLatestRunForChildSession: (sessionKey) => {
          for (const candidate of subagentRuns.values()) {
            if (candidate.childSessionKey === sessionKey) {
              return candidate;
            }
          }
          return null;
        },
        suppressAnnounceForSteerRestart: () => false,
        resolveSubagentTask: (candidate) => {
          const resolved = findTaskByRunId(candidate.taskRunId ?? candidate.runId);
          return resolved ? { lookup: "available", task: resolved } : { lookup: "available" };
        },
        shouldEmitEndedHookForRun: () => false,
        emitSubagentEndedHookForRun: async () => {},
        emitSubagentProgressEndedForRun: async () => {},
        notifyContextEngineSubagentEnded: async () => {},
        retireSupersededRun: async () => {},
        resumeSubagentRun: () => {},
        callGateway: async () => ({}) as never,
        captureSubagentCompletionReply: async () => undefined,
        runSubagentAnnounceFlow: async () => "retryable",
        maybeWakeRequesterAfterAllChildrenSettled: async () => false,
        warn: () => {},
      });
      await expiryController.finalizeResumedAnnounceGiveUp({
        runId: childRunId,
        entry,
        reason: "expiry",
      });

      expectNoDuplicateFallback();
      expect(shouldPreferOriginalCompletionHandoff({ directIdempotencyKey: handoffKey })).toBe(
        false,
      );
      expectRegistryCustody({
        status: "suspended",
        suspendedReason: "expiry",
        suspendedAt: expect.any(Number),
      });
      expectNoDuplicateFallback();

      releaseHeldTurn?.();
      releaseHeldTurn = undefined;
      const terminal = await original;
      expect(terminal).toMatchObject({ runId: handoffKey, status: "ok" });
      pendingOriginal = undefined;
      await expectRegistryCustodyAfterReload({
        status: "suspended",
        suspendedReason: "expiry",
        suspendedAt: expect.any(Number),
      });
      await drainGatewayRootsForTest();
    },
  );
});
