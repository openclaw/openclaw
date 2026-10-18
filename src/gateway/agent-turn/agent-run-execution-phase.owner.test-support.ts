import { onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { SessionFollowupCompletion } from "../../agents/subagents/completion/session-followup-completion.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { getRpcSourceIdentity } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { registerChatAbortController } from "../chat-abort.js";
import { startAgentRunExecution } from "./agent-run-execution-phase.js";
import { createTestRpcSource, testRpcSourceController } from "./rpc-source.test-support.js";

export function createExecution(
  options: {
    aborted?: boolean;
    assertContextCurrent?: () => void;
    pendingInputSettlement?: () => Promise<void>;
  } = {},
) {
  const abortCleanup = vi.fn();
  let gatewayActive = true;
  const gatewayRelease = vi.fn(() => {
    gatewayActive = false;
  });
  const callerRelease = vi.fn();
  const runtimeRelease = vi.fn(async () => {});
  const controller = new AbortController();
  if (options.aborted) {
    controller.abort();
  }
  return {
    abortCleanup,
    gatewayRelease,
    callerRelease,
    runtimeRelease,
    params: {
      assertContextCurrent: options.assertContextCurrent,
      prepared: {
        releaseCallerAuthority: callerRelease,
        activeGatewayWorkAdmission: {
          release: gatewayRelease,
          isActive: () => gatewayActive,
          run: async (run: () => Promise<void>) => await run(),
        },
        activeRunAbort: {
          cleanup: abortCleanup,
          controller,
          registered: false,
        },
        effectiveAllowModelOverride: false,
        lifecycleStorePath: "",
        operationalRunInstance: {},
        preparedModelRuntimeLease: { [Symbol.asyncDispose]: runtimeRelease, snapshot: {} },
        replyDispatchRuntime: {
          config: { runtime: "A" },
          pluginGeneration: "generation-A",
        },
        unpersistedOffloadedRefs: [],
        userTurn: {
          recorder: options.pendingInputSettlement
            ? { waitForPendingInputSettlement: options.pendingInputSettlement }
            : undefined,
          execApprovalFollowupHandoffClaimId: "claim",
          message: "continue",
          senderIsOwner: false,
          suppressPromptPersistence: false,
        },
        workspaceOverride: "/workspace/A",
      },
      request: {},
      cfg: {},
      activeSessionAgentId: "main",
      delivery: {},
      isNewSession: false,
      isRawModelRun: true,
      isOneShotModelRun: true,
      isRestartRecoveryResumeRun: false,
      suppressVisibleSessionEffects: true,
      images: [],
      imageOrder: [],
      media: [],
      runId: "owner-test",
      agentDedupeKeys: [],
      bestEffortDeliver: false,
      lifecycleGeneration: "test",
      preserveUserFacingSessionModelState: false,
      skipAgentInitialSessionTouch: true,
      canUseInternalRuntimeHandoff: false,
      client: null,
      context: {
        getSessionEventSubscriberConnIds: () => new Set(),
        dedupe: new Map(),
        deps: {},
        logGateway: { error: vi.fn(), warn: vi.fn() },
      },
      io: {
        emitAcceptance: vi.fn(),
        emitFinal: vi.fn(),
      },
      releaseCronContinuationClaimWithRecovery: async () => true,
    } as unknown as Parameters<typeof startAgentRunExecution>[0],
  };
}

export async function bindRegisteredExecution(
  execution: ReturnType<typeof createExecution>,
  sessionKey: string,
  sessionId: string,
) {
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const operationalRunInstance = createOperationalRunInstanceRef(execution.params.runId);
  const target = captureSessionTarget({
    storeScope: `/synthetic/agent-execution/${sessionId}/sessions.db`,
    sessionKey,
    incarnation: sessionId,
    agentId: "main",
  });
  const sourceWork = createDeferred();
  const registration = registerChatAbortController({
    target,
    runId: execution.params.runId,
    sessionKey,
    sessionId,
    agentId: "main",
    operationalRunInstance,
    kind: "agent",
    lifecycleGeneration,
    timeoutMs: 60_000,
    sourceWork: sourceWork.promise,
  });
  if (!registration.entry) {
    throw new Error("Expected an owned execution registration");
  }
  Object.assign(execution.params, {
    resolvedSessionKey: sessionKey,
    resolvedSessionId: sessionId,
    lifecycleGeneration,
  });
  Object.assign(execution.params.prepared, {
    activeRunAbort: registration,
    operationalRunInstance,
    lifecycleStorePath: target.storeScope,
    activeGatewayWorkAdmission: await beginSessionEffect({
      target,
      sourceInput: registration.entry.input,
      assertAllowed: () => {},
    }),
  });
  registration.initializeTiming();
  onTestFinished(() => {
    sourceWork.resolve();
    registration.cleanup();
    execution.params.prepared.activeGatewayWorkAdmission?.release();
  });
  return {
    ...registration,
    run: () => {
      const completion = startAgentRunExecution(execution.params);
      // Execution has installed its own cleanup custody before preparation releases.
      sourceWork.resolve();
      return completion;
    },
  };
}

export function createVisibleExecution() {
  const execution = createExecution();
  const sessionKey = "agent:main:task-access-liveness";
  Object.assign(execution.params, {
    suppressVisibleSessionEffects: false,
    requestedSessionKey: sessionKey,
    resolvedSessionKey: sessionKey,
  });
  Object.assign(execution.params.context, {
    getRuntimeConfig: () => ({}),
    getSessionEventSubscriberConnIds: () => new Set(),
  });
  execution.params.prepared.activeRunAbort.markExecutionStarted = vi.fn(() => true);
  execution.params.prepared.userTurn.recorder = {
    finishPendingInput: vi.fn(),
  } as unknown as NonNullable<typeof execution.params.prepared.userTurn.recorder>;
  return execution;
}

export function bindFollowupCompletion(execution: ReturnType<typeof createExecution>) {
  const { params } = execution;
  const sessionKey = "agent:main:followup-owner";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const entry = createTestRpcSource(
    {
      sessionId: "followup-session",
      sessionKey,
      operationalRunInstance: params.prepared.operationalRunInstance,
      lifecycleGeneration,
    },
    params.runId,
  );
  if (params.prepared.activeRunAbort.controller.signal.aborted) {
    testRpcSourceController(entry).abort();
  }
  params.prepared.lifecycleStorePath = entry.input.mailbox.owner.target!.storeScope;
  params.resolvedSessionKey = sessionKey;
  params.resolvedSessionId = getRpcSourceIdentity(entry).sessionId;
  params.lifecycleGeneration = lifecycleGeneration;
  rpcSourceTesting.reset([[params.runId, entry]]);
  const previousAbort = params.prepared.activeRunAbort;
  params.prepared.activeRunAbort = {
    registered: true,
    controller: testRpcSourceController(entry),
    entry,
    initializeTiming: previousAbort.initializeTiming,
    markExecutionStarted: previousAbort.markExecutionStarted,
    bindAgentRunDelegatedAuthority: previousAbort.bindAgentRunDelegatedAuthority,
    cleanup: previousAbort.cleanup,
  };
  params.prepared.activeGatewayWorkAdmission!.isActive = () => true;
  execution.abortCleanup.mockImplementation(() => {
    if (rpcSourceTesting.get(params.runId) === entry) {
      rpcSourceTesting.delete(params.runId);
    }
  });
  const custody = new AbortController();
  const owner = SessionFollowupCompletion.bind({
    runId: params.runId,
    requesterSessionKey: "agent:main:requester",
    requesterSessionId: "requester-session",
    requesterAgentId: "main",
    targetAgentId: "main",
    targetSessionKey: sessionKey,
    custody: {
      signal: custody.signal,
      assertCurrent: () => custody.signal.throwIfAborted(),
      run: (work) => work(),
      release: () => custody.abort(),
    },
  });
  owner.markAccepted(params.runId);
  params.prepared.followupCompletion = owner;
  return owner;
}
