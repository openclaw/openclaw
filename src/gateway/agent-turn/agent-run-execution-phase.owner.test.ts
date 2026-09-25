import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { resolveAgentRunContext } from "../../agents/command/run-context.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import type { SessionEntry } from "../../config/sessions.js";
import { getAgentEventLifecycleGeneration, onAgentEvent } from "../../infra/agent-events.js";
import {
  beginSessionWorkAdmission,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  startSessionWorkAdmissionInterruption,
} from "../../sessions/session-lifecycle-admission.js";
import * as taskRuntime from "../../tasks/runtime-internal.js";
import { readTaskRegistryRevision } from "../../tasks/task-registry-state.js";
import {
  createTaskFixture,
  withTaskRegistryTempDir,
} from "../../tasks/task-registry.test-support.js";
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
import { identifiedClient, runTaskHandler } from "../server-methods/tasks.test-helpers.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { resolveAgentDeliveryPhase } from "./agent-delivery-phase.js";
import * as agentHandlerHelpers from "./agent-handler-helpers.js";
import { startAgentRunExecution } from "./agent-run-execution-phase.js";
import type { AgentTurnPrincipal } from "./types.js";

const { dispatchAgentRunFromGateway, agentCommand } = vi.hoisted(() => ({
  dispatchAgentRunFromGateway: vi.fn(),
  agentCommand: vi.fn(),
}));

vi.mock("../../commands/agent.js", () => ({
  agentCommandFromGatewayIngress: agentCommand,
}));

vi.mock("./agent-run-dispatch.js", () => ({
  dispatchAgentRunFromGateway,
  resolveAbortedAgentStopReason: () => "rpc",
}));

function createExecution(options: { aborted?: boolean; assertContextCurrent?: () => void } = {}) {
  const abortCleanup = vi.fn();
  const gatewayRelease = vi.fn();
  const callerRelease = vi.fn();
  const { promise: runtimeReleased, resolve: resolveRuntimeReleased } = createDeferred();
  const runtimeRelease = vi.fn(async () => resolveRuntimeReleased());
  const controller = new AbortController();
  if (options.aborted) {
    controller.abort();
  }
  return {
    abortCleanup,
    gatewayRelease,
    callerRelease,
    runtimeRelease,
    runtimeReleased,
    params: {
      assertContextCurrent: options.assertContextCurrent,
      prepared: {
        releaseCallerAuthority: callerRelease,
        activeGatewayWorkAdmission: {
          release: gatewayRelease,
          run: async (run: () => Promise<void>) => await run(),
        },
        activeRunAbort: {
          cleanup: abortCleanup,
          controller,
          registered: false,
        },
        dispatchTaskTrackingMode: "none",
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

function createVisibleExecution() {
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

describe("startAgentRunExecution Gateway ownership", () => {
  beforeEach(() => {
    dispatchAgentRunFromGateway.mockReset();
    agentCommand.mockReset();
  });

  it.each(["success", "startup failure"] as const)(
    "retains raw disposal after its real terminal producer settles %s",
    async (outcome) => {
      const execution = createExecution();
      const controllers = new Map<string, ChatAbortControllerEntry>();
      const instance = createOperationalRunInstanceRef(execution.params.runId);
      const registration = registerChatAbortController({
        chatAbortControllers: controllers,
        runId: execution.params.runId,
        sessionKey: "agent:main:composed-terminal-disposal",
        sessionId: "composed-terminal-disposal",
        operationalRunInstance: instance,
        kind: "agent",
        timeoutMs: 60_000,
      });
      if (!registration.entry) {
        throw new Error("Expected the composed execution registration");
      }
      const entry = registration.entry;
      execution.params.prepared.activeRunAbort = registration;
      execution.params.prepared.operationalRunInstance = instance;
      execution.params.lifecycleGeneration = getAgentEventLifecycleGeneration();
      Object.assign(
        execution.params.context,
        createChatAbortContext({ ...execution.params.context, chatAbortControllers: controllers }),
      );
      const admission = await beginSessionWorkAdmission({
        scope: "composed-terminal-disposal",
        identities: [entry.sessionKey, entry.sessionId],
        assertAllowed: () => {},
      });
      execution.params.prepared.activeGatewayWorkAdmission = admission;
      const commandEntered = createDeferred();
      const finishCommand = createDeferred();
      const saveEntered = createDeferred();
      const finishSave = createDeferred();
      const disposalEntered = createDeferred();
      const finishDisposal = createDeferred();
      agentCommand.mockImplementationOnce(async () => {
        commandEntered.resolve();
        await finishCommand.promise;
        if (outcome === "startup failure") {
          throw new Error("Synthetic command startup failure");
        }
        return { payloads: [], meta: {} };
      });
      const actualDispatch =
        await vi.importActual<typeof import("./agent-run-dispatch.js")>("./agent-run-dispatch.js");
      dispatchAgentRunFromGateway.mockImplementationOnce(
        actualDispatch.dispatchAgentRunFromGateway,
      );
      execution.runtimeRelease.mockImplementation(async () => {
        disposalEntered.resolve();
        await finishDisposal.promise;
      });
      const finished = vi.fn();
      const completion = startAgentRunExecution(execution.params).then(finished);
      try {
        await Promise.race([
          commandEntered.promise,
          disposalEntered.promise.then(() => {
            throw new Error("Execution entered disposal before command dispatch");
          }),
        ]);
        const producer = entry.resolveTerminalProducer?.();
        expect(
          producer?.handoff(async (producerCompleted) => {
            await producerCompleted;
            saveEntered.resolve();
            await finishSave.promise;
          }),
        ).toBe(true);
        finishCommand.resolve();
        await Promise.race([
          saveEntered.promise,
          disposalEntered.promise.then(() => {
            throw new Error("Execution entered disposal before its terminal save");
          }),
        ]);
        expect(execution.runtimeRelease).not.toHaveBeenCalled();
        expect(entry.executionSettlement?.status).toBe("pending");
        finishSave.resolve();
        await disposalEntered.promise;
        expect(entry.resolveTerminalProducer?.()).toBeUndefined();
        expect(entry.registrationCleanupRequested).toBe(true);
        expect(entry.projectSessionActive).toBe(false);
        expect(controllers.get(execution.params.runId)).toBe(entry);
        expect(entry.executionSettlement?.status).toBe("pending");
        expect(execution.callerRelease).not.toHaveBeenCalled();
        expect(finished).not.toHaveBeenCalled();
        finishDisposal.resolve();
        await completion;
        expect(entry.executionSettlement?.status).toBe("fulfilled");
        expect(controllers.has(execution.params.runId)).toBe(false);
        expect(execution.callerRelease).toHaveBeenCalledOnce();
      } finally {
        finishCommand.resolve();
        finishSave.resolve();
        finishDisposal.resolve();
        await completion;
        admission.release();
        controllers.clear();
      }
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
        await dispatch.ingressOpts.onExecutionStarted();
        dispatch.cleanupAbortController();
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

  it("serves a held Tasks page despite ordinary agent progress before the final response", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("cli", {
        requesterSessionKey: "agent:main:task-access-liveness",
        task: "Stable task",
        notifyPolicy: "silent",
      });
      dispatchAgentRunFromGateway.mockImplementation(async (dispatch) => {
        dispatch.ingressOpts.onExecutionStarted();
        dispatch.cleanupAbortController();
      });
      const select = taskRuntime.listTaskRecordPage;
      const selection = vi
        .spyOn(taskRuntime, "listTaskRecordPage")
        .mockImplementation(async (params) => {
          const page = await select(params);
          if (page.ok) {
            const revision = readTaskRegistryRevision();
            // Every old-code retry sees only liveness, never a task creation or row update.
            await startAgentRunExecution(createVisibleExecution().params);
            expect(readTaskRegistryRevision()).toBe(revision);
          }
          return page;
        });
      try {
        const result = await runTaskHandler(
          "tasks.list",
          {},
          {},
          identifiedClient(["operator.admin"]),
        );
        expect({
          selections: selection.mock.calls.length,
          ok: result.calls[0]?.[0],
          error: result.calls[0]?.[2],
        }).toEqual({
          selections: 1,
          ok: true,
          error: undefined,
        });
        expect(result.payload?.tasks).toMatchObject([{ id: task.taskId }]);
        expect(selection).toHaveBeenCalledOnce();
        expect(dispatchAgentRunFromGateway).toHaveBeenCalledOnce();
      } finally {
        selection.mockRestore();
      }
    });
  });

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
    dispatchAgentRunFromGateway.mockResolvedValueOnce(undefined);

    await startAgentRunExecution(execution.params);

    expect(dispatchAgentRunFromGateway).toHaveBeenCalledOnce();
    const dispatch = dispatchAgentRunFromGateway.mock.calls[0]?.[0];
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
      dispatchAgentRunFromGateway.mockResolvedValueOnce(undefined);

      await startAgentRunExecution(execution.params);

      expect(dispatchAgentRunFromGateway).toHaveBeenCalledOnce();
      const dispatch = dispatchAgentRunFromGateway.mock.calls[0]?.[0];
      expect(dispatch?.ingressOpts.runContext.messageChannel).toBe(sourceChannel);
      expect(dispatch?.ingressOpts.runContext.currentChannelId).toBeUndefined();
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
      return cleanupObserved;
    });

    const completion = startAgentRunExecution(execution.params);

    await dispatched;
    expect(dispatchedGeneration).toBe(
      execution.params.prepared.replyDispatchRuntime.pluginGeneration,
    );
    expect(dispatchedSnapshot).toBe(execution.params.prepared.preparedModelRuntimeLease.snapshot);
    const dispatch = dispatchAgentRunFromGateway.mock.calls[0]?.[0];
    expect(dispatch?.commandRuntimeContext).toEqual({
      config: { runtime: "A" },
      pluginGeneration: "generation-A",
    });
    expect(dispatch?.ingressOpts.workspaceDir).toBe("/workspace/A");
    expect(execution.runtimeRelease).not.toHaveBeenCalled();

    dispatch?.cleanupAbortController();
    dispatch?.cleanupAbortController();
    expect(execution.callerRelease).not.toHaveBeenCalled();
    resolveCleanupObserved();
    await expect(borrowedAfterCleanup).resolves.toBeUndefined();
    await completion;
    expect(execution.runtimeRelease).toHaveBeenCalledOnce();
    expect(execution.callerRelease).toHaveBeenCalledOnce();
  });

  it("releases the admitted runtime once when aborted before dispatch", async () => {
    const execution = createExecution({ aborted: true });

    await startAgentRunExecution(execution.params);
    expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
    expect(execution.abortCleanup).toHaveBeenCalledOnce();
    expect(execution.gatewayRelease).toHaveBeenCalledOnce();
    expect(execution.runtimeRelease).toHaveBeenCalledOnce();
    expect(execution.callerRelease).toHaveBeenCalledOnce();
  });

  it("joins asynchronous runtime disposal before execution finishes", async () => {
    const execution = createExecution({ aborted: true });
    const { promise: disposal, resolve: finishDisposal } = createDeferred();
    execution.runtimeRelease.mockImplementation(() => disposal);
    const finished = vi.fn();
    const completion = startAgentRunExecution(execution.params).then(finished);
    await vi.waitFor(() => expect(execution.runtimeRelease).toHaveBeenCalledOnce());
    expect(execution.callerRelease).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    finishDisposal();
    await completion;
    expect(finished).toHaveBeenCalledOnce();
    expect(execution.callerRelease).toHaveBeenCalledOnce();
  });

  it("joins prewriter disposal outside the session mutation so nested cleanup can run", async ({
    signal,
  }) => {
    const execution = createExecution();
    const target = {
      scope: "gateway-execution-disposal-order",
      identities: ["agent:main:execution-disposal-order", "execution-disposal-session"],
    };
    const dispatchEntered = createDeferred();
    const allowDispatch = createDeferred();
    const nestedCleanupEntered = createDeferred();
    const allowDisposal = createDeferred();
    const order: string[] = [];
    const admission = await beginSessionWorkAdmission({
      ...target,
      assertAllowed: () => {},
      onInterrupt: (reason) => {
        execution.params.prepared.activeRunAbort.controller.abort(reason);
        allowDispatch.resolve();
        return { runId: execution.params.runId };
      },
    });
    execution.params.prepared.activeGatewayWorkAdmission = admission;
    const dispatchYield = vi
      .spyOn(agentHandlerHelpers, "yieldAfterAgentAcceptedAck")
      .mockImplementation(async () => {
        dispatchEntered.resolve();
        await allowDispatch.promise;
      });
    execution.runtimeRelease.mockImplementation(async () => {
      await runExclusiveSessionLifecycleMutation({
        ...target,
        run: async () => {
          order.push("nested cleanup");
          nestedCleanupEntered.resolve();
        },
      });
      await allowDisposal.promise;
      order.push("disposal settled");
    });
    const unblock = () => {
      admission.release();
      allowDispatch.resolve();
      allowDisposal.resolve();
    };
    signal.addEventListener("abort", unblock, { once: true });
    const completion = startAgentRunExecution(execution.params).then(() => {
      order.push("execution settled");
    });
    let mutation: Promise<void> | undefined;
    try {
      await dispatchEntered.promise;
      mutation = runExclusiveSessionLifecycleMutation({
        ...target,
        prepare: async () => {
          const interruption = startSessionWorkAdmissionInterruption(target);
          expect(interruption.interruptedRunIds.has(execution.params.runId)).toBe(true);
          await interruption.released;
          order.push("logical admission released");
        },
        run: async () => {},
        finalize: async () => {
          order.push("outer mutation finalized");
        },
      });
      await nestedCleanupEntered.promise;
      await mutation;
      expect(admission.isActive()).toBe(false);
      expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
      expect(execution.callerRelease).not.toHaveBeenCalled();
      expect(order).toEqual([
        "logical admission released",
        "outer mutation finalized",
        "nested cleanup",
      ]);
      const joined = completion.then(() => order.push("captured tail joined"));
      allowDisposal.resolve();
      await joined;
      expect(order.slice(3)).toEqual([
        "disposal settled",
        "execution settled",
        "captured tail joined",
      ]);
      expect(execution.callerRelease).toHaveBeenCalledOnce();
    } finally {
      unblock();
      await Promise.allSettled([completion, mutation]);
      signal.removeEventListener("abort", unblock);
      dispatchYield.mockRestore();
    }
  });

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

  it("joins terminal persistence created by its own active lifecycle cancellation", async () => {
    const controllers = new Map<string, ChatAbortControllerEntry>();
    const runId = "active-self-terminal";
    const sessionKey = "agent:main:active-self-terminal";
    const sessionId = "active-self-terminal-session";
    const registration = registerChatAbortController({
      chatAbortControllers: controllers,
      runId,
      sessionKey,
      sessionId,
      kind: "agent",
      agentId: "main",
      timeoutMs: 60_000,
    });
    if (!registration.entry) {
      throw new Error("Expected active registration");
    }
    const entry = registration.entry;
    const context = createChatAbortContext({
      chatAbortControllers: controllers,
    }) as unknown as GatewayRequestContext;
    const persistence = createDeferred();
    const writeEntered = createDeferred();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId !== runId || event.stream !== "lifecycle" || event.data.phase !== "end") {
        return;
      }
      entry.projectSessionTerminalPending = false;
      entry.projectSessionTerminalPersistence = persistence.promise;
      void persistence.promise.then(() => {
        entry.projectSessionTerminalPersistence = undefined;
        entry.projectSessionTerminalPersisted = true;
        abortLifecycle.removeChatAbortControllerEntry(controllers, runId, entry);
      });
      setTimeout(() => persistence.resolve(), 1);
      writeEntered.resolve();
    });
    try {
      await abortLifecycle.runWithChatAbortExecution(
        entry,
        async () => {
          const draining = prepareSessionLifecycleDrain({
            action: "delete",
            context,
            storePath: "gateway-active-self-terminal",
            sessionKeys: [sessionKey],
            sessionKey,
            sessionId,
            agentId: "main",
            defaultAgentId: "main",
            lifecycleIdentities: [sessionKey, sessionId],
          }).then(
            (drain) => ({ drain }),
            (error: unknown) => ({ error }),
          );
          await writeEntered.promise;
          await vi.advanceTimersByTimeAsync(1);
          const outcome = await draining;
          expect(outcome).not.toHaveProperty("error");
          if ("drain" in outcome) {
            expect(outcome.drain.hasAuthoritativeWork()).toBe(false);
            outcome.drain.release();
          }
          registration.cleanup();
        },
        registration.cleanup,
      );
    } finally {
      persistence.resolve();
      unsubscribe();
      controllers.clear();
      vi.useRealTimers();
    }
  });

  it("releases the admitted runtime once when its owner retires before dispatch", async () => {
    const execution = createExecution({
      assertContextCurrent: () => {
        throw new Error("Gateway owner retired");
      },
    });

    await startAgentRunExecution(execution.params);
    expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
    expect(execution.abortCleanup).toHaveBeenCalledOnce();
    expect(execution.gatewayRelease).toHaveBeenCalledOnce();
    expect(execution.runtimeRelease).toHaveBeenCalledOnce();
  });
});
