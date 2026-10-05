import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveAgentRunContext } from "../../agents/command/run-context.js";
import { commitMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { createMainSessionRecoveryStoreFixture } from "../../agents/main-session-recovery/main-session-recovery-store.test-support.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import { SessionFollowupCompletion } from "../../agents/subagents/completion/session-followup-completion.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  beginSessionWorkAdmission,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-lifecycle-admission.js";
import { isWebchatClient } from "../../utils/message-channel.js";
import * as abortLifecycle from "../chat-abort-lifecycle-internal.js";
import {
  isChatAbortControllerEntryAbortable,
  registerChatAbortController,
  type ChatAbortControllerEntry,
} from "../chat-abort.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { createChatAbortContext } from "../server-methods/chat.abort.test-helpers.js";
import * as sessionChange from "../server-methods/session-change-event.js";
import { prepareSessionLifecycleDrain } from "../server-methods/sessions-lifecycle-drain.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { replayAgentTurnIfCached } from "./agent-dedupe.js";
import { resolveAgentDeliveryPhase } from "./agent-delivery-phase.js";
import * as agentHandlerHelpers from "./agent-handler-helpers.js";
import {
  createExecution,
  registerAgentRunDisposalTests,
} from "./agent-run-execution-disposal.test-support.js";
import { startAgentRunExecution } from "./agent-run-execution-phase.js";
import type { AgentTurnPrincipal } from "./types.js";

const { dispatchAgentRunFromGateway, agentCommand } = vi.hoisted(() => ({
  dispatchAgentRunFromGateway:
    vi.fn<typeof import("./agent-run-dispatch.js").dispatchAgentRunFromGateway>(),
  agentCommand: vi.fn<typeof import("../../commands/agent.js").agentCommandFromGatewayIngress>(),
}));

vi.mock("../../commands/agent.js", () => ({
  agentCommandFromGatewayIngress: agentCommand,
}));

vi.mock("./agent-run-dispatch.js", () => ({
  dispatchAgentRunFromGateway,
}));

const completedDispatch: Awaited<
  ReturnType<typeof import("./agent-run-dispatch.js").dispatchAgentRunFromGateway>
> = { terminalOutcome: { reason: "completed", status: "ok" }, settled: false };

function createVisibleExecution() {
  const execution = createExecution();
  const sessionKey = "agent:main:task-access-liveness";
  Object.assign(execution.params, {
    suppressVisibleSessionEffects: false,
    requestedSessionKey: sessionKey,
    resolvedSessionKey: sessionKey,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
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

function bindFollowupCompletion(execution: ReturnType<typeof createExecution>) {
  const { params } = execution;
  const sessionKey = "agent:main:followup-owner";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const entry: ChatAbortControllerEntry = {
    controller: params.prepared.activeRunAbort.controller,
    sessionId: "followup-session",
    sessionKey,
    operationalRunInstance: params.prepared.operationalRunInstance,
    lifecycleGeneration,
    startedAtMs: 1,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  };
  params.resolvedSessionKey = sessionKey;
  params.resolvedSessionId = entry.sessionId;
  params.lifecycleGeneration = lifecycleGeneration;
  params.context.chatAbortControllers = new Map([[params.runId, entry]]);
  params.prepared.activeRunAbort = {
    ...params.prepared.activeRunAbort,
    registered: true,
    entry,
  };
  params.prepared.activeGatewayWorkAdmission.isActive = () => true;
  execution.abortCleanup.mockImplementation(() => {
    if (params.context.chatAbortControllers.get(params.runId) === entry) {
      params.context.chatAbortControllers.delete(params.runId);
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

describe("startAgentRunExecution Gateway ownership", () => {
  const recoveryFixture = createMainSessionRecoveryStoreFixture();
  const reserveExecution = async (execution: ReturnType<typeof createExecution>) => {
    onTestFinished(recoveryFixture.resetCase);
    const entry = execution.params.sessionEntry;
    if (!entry) {
      throw new Error("recovery fixture requires its existing session");
    }
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const scope = { sessionKey: "agent:main:main", storePath: recoveryFixture.fixtureStore() };
    const state = {
      cycleId: "execution-cycle",
      revision: 1,
      chargedAttempts: 0,
    };
    await replaceSessionEntry(scope, {
      ...entry,
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: state,
    });
    const reserved = await commitMainSessionRecovery({
      target: scope,
      command: {
        kind: "prepare_attempt",
        now: 200,
        attempt: state.chargedAttempts + 1,
        lifecycleGeneration,
        observation: {
          sessionId: entry.sessionId,
          cycleId: state.cycleId,
          revision: state.revision,
        },
        runId: execution.params.runId,
        executionIdentity: { state: "disabled" },
      },
    });
    expect(reserved.transition.kind).toBe("reserved");
    execution.params.prepared.lifecycleStorePath = scope.storePath;
    execution.params.resolvedSessionKey = scope.sessionKey;
    execution.params.lifecycleGeneration = lifecycleGeneration;
    return scope;
  };
  beforeEach(() => {
    dispatchAgentRunFromGateway.mockReset();
    agentCommand.mockReset();
  });

  registerAgentRunDisposalTests({ dispatchAgentRunFromGateway, agentCommand });

  it("retains an inactive exact run owner after prewriter cleanup until disposal settles", async () => {
    const execution = createExecution();
    const controllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers: controllers,
      runId: execution.params.runId,
      sessionId: "retained-disposal-session",
      sessionKey: "agent:main:retained-disposal",
      agentId: "main",
      kind: "agent",
      operationalRunInstance: execution.params.prepared.operationalRunInstance,
      timeoutMs: 60_000,
    });
    if (!registration.registered) {
      throw new Error("Expected an owned execution registration");
    }
    registration.controller.abort();
    execution.params.prepared.activeRunAbort = registration;
    execution.params.context.chatAbortControllers = controllers;
    const admission = await beginSessionWorkAdmission({
      scope: "gateway-retained-disposal",
      identities: [registration.entry.sessionKey, registration.entry.sessionId],
      assertAllowed: () => {},
    });
    execution.params.prepared.activeGatewayWorkAdmission = admission;
    const disposalEntered = createDeferred();
    const allowDisposal = createDeferred();
    execution.runtimeRelease.mockImplementation(async () => {
      disposalEntered.resolve();
      await allowDisposal.promise;
    });
    const completion = startAgentRunExecution(execution.params);
    try {
      await disposalEntered.promise;
      expect(registration.entry.registrationCleanupRequested).toBe(true);
      expect(admission.isActive()).toBe(false);
      expect(controllers.get(execution.params.runId)).toBe(registration.entry);
      expect(registration.entry.projectSessionActive).toBe(false);
      expect(isChatAbortControllerEntryAbortable(registration.entry)).toBe(false);
      expect(registration.markExecutionStarted()).toBe(false);
      expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
      expect(execution.callerRelease).not.toHaveBeenCalled();
      allowDisposal.resolve();
      await completion;
      expect(controllers.has(execution.params.runId)).toBe(false);
    } finally {
      allowDisposal.resolve();
      await completion;
      admission.release();
    }
  });

  it("lets a disposer drain its real session without waiting on its own retained execution", async () => {
    const execution = createExecution();
    const controllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers: controllers,
      runId: execution.params.runId,
      sessionId: "self-disposal-session",
      sessionKey: "agent:main:self-disposal",
      agentId: "main",
      kind: "agent",
      operationalRunInstance: execution.params.prepared.operationalRunInstance,
      timeoutMs: 60_000,
    });
    if (!registration.registered) {
      throw new Error("Expected an owned execution registration");
    }
    registration.controller.abort();
    execution.params.prepared.activeRunAbort = registration;
    const context = createChatAbortContext({
      ...execution.params.context,
      chatAbortControllers: controllers,
    }) as unknown as GatewayRequestContext;
    execution.params.context = context;
    const { sessionKey, sessionId } = registration.entry;
    const selected = createDeferred();
    const waitForRemoval = abortLifecycle.waitForChatAbortControllerRemoval;
    const observedWait = vi
      .spyOn(abortLifecycle, "waitForChatAbortControllerRemoval")
      .mockImplementation((params) => {
        const completion = waitForRemoval(params);
        if (params.targets.some((target) => target.entry === registration.entry)) {
          selected.resolve();
        }
        return completion;
      });
    const dispatchYield = vi
      .spyOn(agentHandlerHelpers, "yieldAfterAgentAcceptedAck")
      .mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    execution.runtimeRelease.mockImplementation(async () => {
      const drain = await prepareSessionLifecycleDrain({
        action: "delete",
        context,
        storePath: "gateway-self-disposal",
        sessionKeys: [sessionKey],
        sessionKey,
        sessionId,
        agentId: "main",
        defaultAgentId: "main",
        lifecycleIdentities: [sessionKey, sessionId],
      });
      try {
        expect(drain.hasAuthoritativeWork()).toBe(false);
      } finally {
        drain.release();
      }
    });
    const completion = startAgentRunExecution(execution.params).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        selected.promise,
        completion.then((error) => {
          throw new Error("Lifecycle drain did not select the retained execution", {
            cause: error,
          });
        }),
      ]);
      // Exercise the existing product bound without sleeping or changing its value.
      await vi.advanceTimersByTimeAsync(SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS);
      expect(await completion).toBeUndefined();
      expect(controllers.has(execution.params.runId)).toBe(false);
      expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
    } finally {
      await completion;
      controllers.clear();
      vi.useRealTimers();
      dispatchYield.mockRestore();
      observedWait.mockRestore();
    }
  });

  it.each(["terminal-error", "manual", "held", "exhausted"] as const)(
    "rechecks %s intent at actual recovery execution instead of stale preparation facts",
    async (change) => {
      onTestFinished(recoveryFixture.resetCase);
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const scope = { sessionKey: "agent:main:main", storePath: recoveryFixture.fixtureStore() };
      const entry: InternalSessionEntry = {
        sessionId: "captured-session",
        lifecycleRevision: "captured-lifecycle",
        updatedAt: 100,
        status: "running",
        abortedLastRun: true,
        goalPauseOrigin: "terminal-error",
        totalTokens: 200,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        goal: {
          schemaVersion: 1,
          id: "captured-goal",
          objective: "Stale pre-admission objective",
          status: "paused",
          createdAt: 10,
          updatedAt: 100,
          tokenStart: 100,
          tokenStartFresh: true,
          tokensUsed: 25,
          tokenBudget: 300,
          continuationTurns: 3,
        },
        restartRecoveryGoal: {
          id: "captured-goal",
          sessionId: "captured-session",
          lifecycleRevision: "captured-lifecycle",
          capturedAtMs: 100,
        },
        mainRestartRecovery: { cycleId: "captured-cycle", revision: 1, chargedAttempts: 0 },
      };
      await replaceSessionEntry(scope, {
        ...entry,
        goal: { ...entry.goal!, objective: "Finish the current accepted objective" },
      });
      await commitMainSessionRecovery({
        target: scope,
        command: {
          kind: "prepare_attempt",
          now: 200,
          attempt: 1,
          lifecycleGeneration,
          observation: { sessionId: entry.sessionId, cycleId: "captured-cycle", revision: 1 },
          runId: "captured-recovery",
          executionIdentity: { state: "disabled" },
        },
      });
      const current = loadSessionEntry(scope)!;
      if (change === "manual") {
        current.goalPauseOrigin = "manual";
      } else if (change === "held") {
        current.goalPauseOrigin = "recovery-hold";
        current.mainRestartRecovery!.pause = {
          reason: "unverifiable-external-effect",
          pausedAtMs: 201,
          goalId: "captured-goal",
        };
      } else if (change === "exhausted") {
        current.goal = { ...current.goal!, tokensUsed: 300, budgetLimitedAt: 77 };
      }
      await replaceSessionEntry(scope, current);
      const execution = createExecution();
      Object.assign(execution.params, {
        sessionEntry: entry,
        resolvedSessionKey: scope.sessionKey,
        resolvedSessionId: entry.sessionId,
        runId: "captured-recovery",
        lifecycleGeneration,
        isRestartRecoveryResumeRun: true,
        canUseInternalRuntimeHandoff: true,
        request: {
          expectedExistingSessionId: entry.sessionId,
          extraSystemPrompt: "Existing instructions",
        },
      });
      execution.params.prepared.lifecycleStorePath = scope.storePath;
      dispatchAgentRunFromGateway.mockImplementationOnce(async (dispatch) => {
        await dispatch.cleanupAbortController();
        return completedDispatch;
      });
      await startAgentRunExecution(execution.params);
      if (change !== "terminal-error") {
        expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
        if (change === "exhausted") {
          expect(loadSessionEntry(scope)?.goal).toMatchObject({
            status: "budget_limited",
            tokenStart: 100,
            tokensUsed: 300,
            budgetLimitedAt: 77,
          });
        } else {
          expect(loadSessionEntry(scope)).toEqual(current);
        }
        return;
      }
      expect(loadSessionEntry(scope)?.goal).toMatchObject({
        status: "active",
        tokenStart: 100,
        tokensUsed: 100,
        continuationTurns: 3,
      });
      expect(dispatchAgentRunFromGateway).toHaveBeenCalledOnce();
      const prompt = dispatchAgentRunFromGateway.mock.calls[0]?.[0].ingressOpts.extraSystemPrompt;
      expect(prompt).toContain("Existing instructions");
      expect(prompt).toContain("Active goal: Finish the current accepted objective");
      expect(prompt).not.toContain("Stale pre-admission objective");
    },
  );

  it.each([false, true])(
    "preserves access across liveness and invalidates creation (new session: %s)",
    async (isNewSession) => {
      const execution = createVisibleExecution();
      execution.params.isNewSession = isNewSession;
      const publish = sessionChange.emitSessionsChanged;
      const notices: Array<{ reason: string; accessChanges: number }> = [];
      const publisher = vi
        .spyOn(sessionChange, "emitSessionsChanged")
        .mockImplementation((...args) => {
          const before = readGatewayAccessRevision();
          publish(...args);
          notices.push({
            reason: args[1].reason,
            accessChanges: readGatewayAccessRevision() - before,
          });
        });
      dispatchAgentRunFromGateway.mockImplementationOnce(async (dispatch) => {
        await dispatch.ingressOpts.onExecutionStarted?.();
        await dispatch.cleanupAbortController();
        return completedDispatch;
      });

      try {
        await startAgentRunExecution(execution.params);

        expect(dispatchAgentRunFromGateway).toHaveBeenCalledOnce();
        expect(notices).toEqual([
          ...(isNewSession ? [{ reason: "create", accessChanges: expect.any(Number) }] : []),
          { reason: "send", accessChanges: 0 },
          { reason: "agent.run.started", accessChanges: 0 },
          { reason: "agent.input.settled", accessChanges: 0 },
        ]);
        if (isNewSession) {
          expect(notices[0]?.accessChanges).toBeGreaterThan(0);
        }
      } finally {
        publisher.mockRestore();
      }
    },
  );

  it.each<{
    name: string;
    webchat?: boolean;
    sourceChannel?: string;
    replyChannel?: string;
    sessionDelivery?: SessionEntry["delivery"];
    expectedChannel?: string;
  }>([
    { name: "unbound CLI" },
    { name: "CLI with internal delivery history", sessionDelivery: { kind: "internal" } },
    { name: "WebChat client", webchat: true, expectedChannel: "webchat" },
    { name: "WebChat continuation", sourceChannel: "webchat", expectedChannel: "webchat" },
    {
      name: "channel continuation with an internal reply override",
      sourceChannel: "discord",
      replyChannel: "webchat",
      expectedChannel: "discord",
    },
    {
      name: "remembered provider without a target",
      sessionDelivery: {
        kind: "external",
        route: { channel: "discord" },
        context: { channel: "discord" },
        origin: { provider: "discord" },
      },
      expectedChannel: "discord",
    },
    { name: "explicit internal channel", replyChannel: "webchat", expectedChannel: "webchat" },
  ])("preserves $name provider context through command resolution", async (testCase) => {
    const execution = createExecution();
    const client: AgentTurnPrincipal = {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          id: testCase.webchat ? "webchat-ui" : "cli",
          mode: testCase.webchat ? "webchat" : "cli",
          version: "test",
          platform: "test",
        },
      },
    };
    const delivery = await resolveAgentDeliveryPhase({
      request: {
        message: "continue",
        idempotencyKey: execution.params.runId,
        replyChannel: testCase.replyChannel,
      },
      cfg: {},
      sessionEntry: testCase.sessionDelivery
        ? { sessionId: "source-session", updatedAt: 1, delivery: testCase.sessionDelivery }
        : undefined,
      agentId: "main",
      recipientChannel: testCase.sourceChannel,
      replyTo: "",
      to: "",
      bestEffortDeliver: false,
      runId: execution.params.runId,
      client,
      context: execution.params.context,
      respond: vi.fn(),
      isWebchatConnect: (connect) => isWebchatClient(connect?.client),
    });
    expect(delivery).toBeDefined();
    if (!delivery) {
      throw new Error("delivery planning failed");
    }
    execution.params.delivery = delivery;
    execution.params.client = client;
    dispatchAgentRunFromGateway.mockResolvedValueOnce(completedDispatch);

    await startAgentRunExecution(execution.params);

    expect(dispatchAgentRunFromGateway).toHaveBeenCalledOnce();
    const dispatch = expectDefined(
      dispatchAgentRunFromGateway.mock.calls[0]?.[0],
      "recorded dispatch",
    );
    const runContext = resolveAgentRunContext(dispatch.ingressOpts);
    expect(runContext.messageChannel).toBe(testCase.expectedChannel);
    expect(runContext.currentChannelId).toBeUndefined();
  });

  it.each([
    { sourceIngress: "control-ui" as const, sourceChannel: "webchat", deliveryContext: undefined },
    {
      sourceIngress: "channel" as const,
      sourceChannel: "discord",
      deliveryContext: { channel: "discord" },
    },
  ])(
    "preserves targetless $sourceChannel policy context at recovery dispatch",
    async ({ sourceIngress, sourceChannel, deliveryContext }) => {
      const execution = createExecution();
      Object.assign(execution.params, {
        canUseInternalRuntimeHandoff: true,
        isRestartRecoveryResumeRun: true,
        resolvedSessionId: "recovery-session",
        sessionEntry: {
          sessionId: "recovery-session",
          updatedAt: 1,
          restartRecoveryDeliveryRunId: execution.params.runId,
          restartRecoveryDeliverySourceRunId: "source-run",
          restartRecoveryDeliveryContext: deliveryContext,
          restartRecoverySourceIngress: sourceIngress,
        },
      });
      execution.params.request.expectedExistingSessionId = "recovery-session";
      execution.params.delivery.originMessageChannel = "slack";
      await reserveExecution(execution);
      dispatchAgentRunFromGateway.mockResolvedValueOnce(completedDispatch);

      await startAgentRunExecution(execution.params);

      expect(dispatchAgentRunFromGateway).toHaveBeenCalledOnce();
      const dispatch = expectDefined(
        dispatchAgentRunFromGateway.mock.calls[0]?.[0],
        "recorded dispatch",
      );
      expect(resolveAgentRunContext(dispatch.ingressOpts).messageChannel).toBe(sourceChannel);
      expect(resolveAgentRunContext(dispatch.ingressOpts).currentChannelId).toBeUndefined();
    },
  );

  it("dispatches with the runtime generation frozen at admission", async () => {
    const execution = createExecution();
    const { promise: dispatched, resolve: resolveDispatched } = createDeferred();
    const { promise: cleanupObserved, resolve: resolveCleanupObserved } = createDeferred();
    let borrowedAfterCleanup: Promise<unknown> | undefined;
    let dispatchedGeneration: unknown;
    let dispatchedSnapshot: unknown;
    dispatchAgentRunFromGateway.mockImplementationOnce(() => {
      const generation = execution.params.prepared.replyDispatchRuntime.pluginGeneration;
      dispatchedGeneration = getPreparedModelRuntimePluginGeneration();
      dispatchedSnapshot = getPreparedModelRuntimeBorrowedSnapshot(generation);
      borrowedAfterCleanup = (async () => {
        await cleanupObserved;
        return getPreparedModelRuntimeBorrowedSnapshot(generation);
      })();
      resolveDispatched();
      return cleanupObserved.then(() => completedDispatch);
    });

    const completion = startAgentRunExecution(execution.params);

    await dispatched;
    expect(dispatchedGeneration).toBe(
      execution.params.prepared.replyDispatchRuntime.pluginGeneration,
    );
    expect(dispatchedSnapshot).toBe(
      expectDefined(execution.params.prepared.preparedModelRuntimeLease, "ready session runtime")
        .snapshot,
    );
    const dispatch = expectDefined(
      dispatchAgentRunFromGateway.mock.calls[0]?.[0],
      "recorded dispatch",
    );
    expect(dispatch?.commandRuntimeContext).toEqual({
      config: { runtime: "A" },
      pluginGeneration: "generation-A",
    });
    expect(dispatch?.ingressOpts.workspaceDir).toBe("/workspace/A");
    expect(execution.runtimeRelease).not.toHaveBeenCalled();

    await dispatch?.cleanupAbortController();
    await dispatch?.cleanupAbortController();
    expect(execution.callerRelease).not.toHaveBeenCalled();
    resolveCleanupObserved();
    await expect(borrowedAfterCleanup).resolves.toBeUndefined();
    await completion;
    expect(execution.runtimeRelease).toHaveBeenCalledOnce();
    expect(execution.callerRelease).toHaveBeenCalledOnce();
  });

  it.each([undefined, "/workspace/session-override"])(
    "preserves the admitted workspace with session override %s",
    async (workspaceOverride) => {
      const execution = createExecution();
      execution.params.prepared.workspaceOverride = workspaceOverride;
      execution.params.prepared.replyDispatchRuntime = {
        ...execution.params.prepared.replyDispatchRuntime,
        workspaceDir: "/workspace/admitted",
      };
      dispatchAgentRunFromGateway.mockResolvedValueOnce(completedDispatch);

      await startAgentRunExecution(execution.params);

      const dispatch = expectDefined(
        dispatchAgentRunFromGateway.mock.calls[0]?.[0],
        "recorded dispatch",
      );
      expect(dispatch?.ingressOpts.workspaceDir).toBe(workspaceOverride ?? "/workspace/admitted");
      expect(execution.runtimeRelease).toHaveBeenCalledOnce();
      expect(execution.callerRelease).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { ending: "aborted", registration: "current" },
    { ending: "failed", registration: "current" },
    { ending: "aborted", registration: "foreign" },
    { ending: "aborted", registration: "absent" },
    { ending: "aborted", registration: "replacement" },
    { ending: "aborted", registration: "controller" },
    { ending: "aborted", registration: "session" },
    { ending: "aborted", registration: "instance" },
    { ending: "aborted", registration: "lifecycle" },
  ] as const)(
    "settles an undispatched $ending followup only after cleanup (registration: $registration)",
    async ({ ending, registration }) => {
      const settlementEntered = createDeferred();
      const finishSettlement = createDeferred();
      const execution = createExecution({
        pendingInputSettlement: async () => {
          settlementEntered.resolve();
          await finishSettlement.promise;
        },
        aborted: ending === "aborted",
        ...(ending === "failed"
          ? {
              assertContextCurrent: () => {
                throw new Error("Gateway owner retired");
              },
            }
          : {}),
      });
      execution.params.agentDedupeKeys = [`agent:${execution.params.runId}`];
      const owner = bindFollowupCompletion(execution);
      const entry = execution.params.prepared.activeRunAbort.entry!;
      const successor =
        registration === "foreign" || registration === "replacement"
          ? {
              ...entry,
              controller: new AbortController(),
              sessionKey: registration === "foreign" ? "agent:main:unrelated" : entry.sessionKey,
              operationalRunInstance: { runId: execution.params.runId, instanceId: "successor" },
            }
          : undefined;
      if (successor) {
        execution.params.context.chatAbortControllers.set(execution.params.runId, successor);
      }
      const lostRegistration = !["current", "foreign", "absent"].includes(registration);
      execution.params.prepared.activeGatewayWorkAdmission.run = async (run) => {
        if (registration === "absent") {
          execution.params.context.chatAbortControllers.delete(execution.params.runId);
        } else if (registration === "controller") {
          entry.controller = new AbortController();
        } else if (registration === "session") {
          entry.sessionKey = "agent:main:unrelated";
        } else if (registration === "instance") {
          entry.operationalRunInstance = { runId: execution.params.runId, instanceId: "successor" };
        } else if (registration === "lifecycle") {
          entry.lifecycleGeneration = "successor-lifecycle";
        }
        return await run();
      };
      const recoveryEntered = createDeferred();
      const releaseRecovery = createDeferred();
      const disposalEntered = createDeferred();
      const finishDisposal = createDeferred();
      execution.params.releaseCronContinuationClaimWithRecovery = async () => {
        recoveryEntered.resolve();
        await releaseRecovery.promise;
        return true;
      };
      execution.runtimeRelease.mockImplementation(async () => {
        disposalEntered.resolve();
        await finishDisposal.promise;
      });
      const finishExecution = vi.spyOn(owner, "finishExecution");
      const replyObserved = vi.fn();
      const reply = owner.take().then((result) => {
        replyObserved(result);
        return result;
      });
      void reply.catch(() => {});
      const finished = vi.fn();
      const completion = startAgentRunExecution(execution.params).then(finished);
      try {
        await Promise.race([recoveryEntered.promise, completion]);
        expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
        expect(execution.params.io.emitFinal).not.toHaveBeenCalled();
        expect(execution.params.context.dedupe.size).toBe(0);
        expect(finishExecution).not.toHaveBeenCalled();
        expect(replyObserved).not.toHaveBeenCalled();
        expect(execution.abortCleanup).not.toHaveBeenCalled();
        releaseRecovery.resolve();
        await Promise.race([settlementEntered.promise, completion]);
        expect(execution.params.io.emitFinal).not.toHaveBeenCalled();
        expect(execution.params.context.dedupe.size).toBe(0);
        expect(execution.abortCleanup).not.toHaveBeenCalled();
        finishSettlement.resolve();
        await Promise.race([disposalEntered.promise, completion]);
        expect(execution.params.io.emitFinal).toHaveBeenCalledOnce();
        expect(execution.params.context.dedupe.size).toBe(1);
        expect(execution.abortCleanup).toHaveBeenCalledOnce();
        expect(execution.gatewayRelease).toHaveBeenCalledOnce();
        expect(execution.runtimeRelease).toHaveBeenCalledOnce();
        expect(execution.callerRelease).not.toHaveBeenCalled();
        expect(finishExecution).not.toHaveBeenCalled();
        expect(replyObserved).not.toHaveBeenCalled();
        expect(finished).not.toHaveBeenCalled();
        finishDisposal.resolve();
        await completion;
        expect(finished).toHaveBeenCalledOnce();
        expect(execution.callerRelease).toHaveBeenCalledOnce();
        expect(finishExecution).toHaveBeenCalledExactlyOnceWith(execution.params.runId);
        if (successor) {
          expect(execution.params.context.chatAbortControllers.get(execution.params.runId)).toBe(
            successor,
          );
        }
        if (lostRegistration) {
          await expect(reply).rejects.toThrow("Follow-up admission was replaced before cleanup.");
        } else {
          await expect(reply).resolves.toMatchObject(
            ending === "aborted"
              ? { status: "error", stopReason: "rpc" }
              : { status: "error", error: "Gateway owner retired" },
          );
        }
      } finally {
        releaseRecovery.resolve();
        finishSettlement.resolve();
        finishDisposal.resolve();
        await completion.catch(() => {});
        owner.close();
      }
    },
  );

  it.each([false, true])(
    "releases the admitted runtime and preserves private failure replay before dispatch (Incognito: %s)",
    async (incognito) => {
      const privateMessage = "synthetic-private-pre-dispatch-error";
      const execution = createVisibleExecution();
      const fail = () => {
        throw new Error(privateMessage);
      };
      execution.params.assertContextCurrent = fail;
      execution.params.prepared.userTurn.releaseProcessingAbortObserver = fail;
      Object.assign(execution.params.prepared.userTurn.recorder ?? {}, {
        completeProcessing: fail,
      });
      execution.params.resolvedSessionKey = "agent:main:dashboard:private-owner";
      execution.params.sessionEntry = {
        sessionId: "private-owner",
        updatedAt: Date.now(),
        ...(incognito ? { incognito: true } : {}),
      };
      execution.params.agentDedupeKeys = [`agent:${execution.params.runId}`];

      await startAgentRunExecution(execution.params);
      expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
      expect(execution.abortCleanup).toHaveBeenCalledOnce();
      expect(execution.gatewayRelease).toHaveBeenCalledOnce();
      expect(execution.runtimeRelease).toHaveBeenCalledOnce();
      const warnings = vi.mocked(execution.params.context.logGateway.warn).mock.calls;
      expect(warnings).toHaveLength(2);
      if (incognito) {
        expect.soft(JSON.stringify(warnings)).not.toContain(privateMessage);
      } else {
        expect(JSON.stringify(warnings)).toContain(privateMessage);
      }
      const [frame, metadata] = vi.mocked(execution.params.io.emitFinal).mock.calls[0] ?? [];
      expect(frame?.[2]?.message).toBe(privateMessage);
      const diagnostics = { errorMessage: frame?.[2]?.message, ...metadata };
      if (incognito) {
        expect.soft(JSON.stringify(diagnostics)).not.toContain(privateMessage);
      } else {
        expect(diagnostics).toMatchObject({ error: privateMessage, errorMessage: privateMessage });
      }

      const emitAcceptance = vi.fn();
      expect(
        replayAgentTurnIfCached({
          preflight: {
            runId: execution.params.runId,
            agentDedupeKeys: execution.params.agentDedupeKeys,
          },
          context: execution.params.context,
          io: { emitAcceptance, emitFinal: vi.fn() },
        }),
      ).toBe(true);
      const [replayFrame, replayMetadata] = emitAcceptance.mock.calls[0] ?? [];
      expect(replayFrame).toEqual(frame);
      const replayDiagnostics = { errorMessage: replayFrame?.[2]?.message, ...replayMetadata };
      if (incognito) {
        expect(JSON.stringify(replayDiagnostics)).not.toContain(privateMessage);
      } else {
        expect(replayDiagnostics).toMatchObject({ cached: true, errorMessage: privateMessage });
      }
    },
  );
});
