import { DatabaseSync } from "node:sqlite";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { prepareEmbeddedSessionState } from "../../agents/command/session-preparation.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import {
  retainPreparedPluginGeneration,
  retainPreparedPluginRegistry,
} from "../../agents/prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "../../agents/prepared-model-runtime.resources.js";
import type { PreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime.types.js";
import { retainRuntimePluginWork } from "../../agents/runtime-plugin-work.js";
import * as runtimePlugins from "../../agents/runtime-plugins.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../../plugins/registry-inspection.test-support.js";
import {
  getCurrentSessionControllerOwner,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-controller.lifecycle.js";
import {
  getRpcSourceIdentity,
  getRpcSourceProjectSessionActive,
  isRpcSourceExecuting,
} from "../../sessions/session-controller.rpc-sources.js";
import {
  resetSessionControllerStateForTest,
  rpcSourceTesting,
} from "../../sessions/session-lifecycle-admission.test-support.js";
import { classifySessionStateActor } from "../../sessions/session-state-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { isWebchatClient } from "../../utils/message-channel.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { createChatAbortContext } from "../server-methods/chat.abort.test-helpers.js";
import * as sessionChange from "../server-methods/session-change-event.js";
import { prepareSessionLifecycleDrain } from "../server-methods/sessions-lifecycle-drain.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { expectSuccessorWorkspaceRead } from "../workspace-readiness.test-support.js";
import { replayAgentTurnIfCached } from "./agent-dedupe.js";
import { resolveAgentDeliveryPhase } from "./agent-delivery-phase.js";
import * as agentHandlerHelpers from "./agent-handler-helpers.js";
import { startAgentRunExecution } from "./agent-run-execution-phase.js";
import {
  createExecution,
  bindRegisteredExecution,
  createVisibleExecution,
  bindFollowupCompletion,
} from "./agent-run-execution-phase.owner.test-support.js";
import { createTestRpcSource } from "./rpc-source.test-support.js";
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
}));

// mock-isolation: Routing cases prepare command context without skills or exec-policy discovery.
vi.mock("../../agents/command/runtime-loaders.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/command/runtime-loaders.js")>()),
  loadSkillsRuntime: async () => ({
    getRemoteSkillEligibility: () => ({}),
    resolveReusableWorkspaceSkillSnapshot: () => ({
      snapshot: undefined,
      shouldRefresh: false,
    }),
  }),
  loadExecDefaultsRuntime: async () => ({
    resolveNodeExecEligibilityAsync: () => ({ canExec: false }),
  }),
}));

function createGate() {
  const entered = createDeferred();
  const finish = createDeferred();
  return {
    entered: entered.promise,
    resolve: finish.resolve,
    wait: () => {
      entered.resolve();
      return finish.promise;
    },
  };
}

function expectCalls(count: number, ...spies: unknown[]) {
  for (const spy of spies) {
    expect(spy).toHaveBeenCalledTimes(count);
  }
}

describe("startAgentRunExecution Gateway ownership", () => {
  it("reads the workspace after resuming from a retired same-session preparation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const execution = createExecution();
      const sessionKey = "agent:main:resumed-workspace";
      execution.params.resolvedSessionKey = sessionKey;
      await expectSuccessorWorkspaceRead({
        workspaceDir: state.workspaceDir,
        sessionKey,
        run: async (readWorkspace) => {
          dispatchAgentRunFromGateway.mockImplementationOnce(async (dispatch) => {
            try {
              await readWorkspace();
            } finally {
              await dispatch.cleanupAbortController();
            }
          });
          await startAgentRunExecution(execution.params);
          expect(dispatchAgentRunFromGateway).toHaveBeenCalledOnce();
        },
      });
    });
  });

  beforeEach(() => {
    dispatchAgentRunFromGateway.mockReset();
    agentCommand.mockReset();
  });

  afterEach(() => resetSessionControllerStateForTest());

  it.each([
    "success",
    "startup failure",
    "publication failure",
    "publication and cleanup failure",
    "cleanup failure",
    "completed cleanup failure",
    "publication and completed cleanup failure",
    "prewriter abort",
  ] as const)("retains the exact run owner through runtime disposal: %s", async (outcome) => {
    const prewriter = outcome === "prewriter abort";
    const execution = createExecution();
    const registration = await bindRegisteredExecution(
      execution,
      prewriter ? "agent:main:retained-disposal" : "agent:main:composed-terminal-disposal",
      prewriter ? "retained-disposal-session" : "composed-terminal-disposal",
    );
    const entry = registration.entry;
    const sourceSettled = vi.fn();
    void entry.input.settlement.promise.then(sourceSettled, sourceSettled);
    if (prewriter) {
      registration.controller.abort();
    }
    const commandEntered = createDeferred();
    const finishCommand = createDeferred();
    const save = createGate();
    const disposal = createGate();
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
    dispatchAgentRunFromGateway.mockImplementationOnce(actualDispatch.dispatchAgentRunFromGateway);
    const publicationFault = new Error("Synthetic final response refusal");
    const publicationFails =
      outcome === "publication failure" ||
      outcome === "publication and cleanup failure" ||
      outcome === "publication and completed cleanup failure";
    const cleanupFails =
      outcome === "cleanup failure" || outcome === "publication and cleanup failure";
    if (publicationFails) {
      vi.mocked(execution.params.io.emitFinal).mockImplementationOnce(() => {
        throw publicationFault;
      });
    }
    const cleanupFault = new Error("Synthetic unfinished runtime cleanup");
    execution.runtimeRelease.mockImplementation(
      prewriter
        ? disposal.wait
        : async () => {
            await disposal.wait();
            if (cleanupFails) {
              throw cleanupFault;
            }
          },
    );
    const callbackFault = new Error("Synthetic completed inspection callback failure");
    let database: DatabaseSync | undefined;
    let nativeDisposals = 0;
    const completedCleanupFails =
      outcome === "completed cleanup failure" ||
      outcome === "publication and completed cleanup failure";
    if (completedCleanupFails) {
      const registry = createEmptyPluginRegistry();
      const resources = new PluginRegistryInspectionResources(retireInspectionInstances);
      resources.attach(registry);
      const native = (database = new DatabaseSync(":memory:"));
      let releaseGeneration: (() => Promise<void>) | undefined = undefined;
      onTestFinished(async () => {
        disposal.resolve();
        await releaseGeneration?.().catch(() => {});
        await resources.release().catch(() => {});
        if (native.isOpen) {
          native.close();
        }
      });
      const nativeDispose = async () => {
        nativeDisposals++;
        await disposal.wait();
        native.close();
        throw callbackFault;
      };
      resources.runRegistration("completed-cleanup", () => {
        resources.register("completed-cleanup", { id: "sqlite", dispose: nativeDispose });
      });
      const construction = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
      const discovery = vi
        .spyOn(runtimePlugins, "acquireAgentRuntimePluginRegistry")
        .mockResolvedValueOnce({
          registry,
          primaryRegistry: registry,
          resources,
          releaseRegistry: resources.release.bind(resources),
          releaseWork: retainRuntimePluginWork([registry]),
        });
      try {
        await construction.load({ config: {} }, () => {});
      } finally {
        discovery.mockRestore();
      }
      const generation: PreparedModelRuntimePluginGeneration = {
        remoteCatalog: null,
        pluginMetadataSnapshot: createPluginMetadataSnapshot({
          config: {},
          manifestRegistry: makeRegistry([]),
        }),
        inlineProviderModels: [],
        configuredCatalogEntries: [],
        pluginRegistry: registry,
      };
      releaseGeneration = retainPreparedPluginGeneration(generation);
      await construction[Symbol.asyncDispose]();
      execution.params.prepared.preparedModelRuntimeLease = {
        ...expectDefined(
          execution.params.prepared.preparedModelRuntimeLease,
          "ready session runtime",
        ),
        pluginGeneration: generation,
        [Symbol.asyncDispose]: releaseGeneration,
      };
      execution.params.prepared.replyDispatchRuntime = {
        ...execution.params.prepared.replyDispatchRuntime,
        pluginGeneration: generation,
      };
    }
    const finished = vi.fn();
    const completion = registration.run().then(finished);
    const observed = completion.catch((error: unknown) => error);
    try {
      if (!prewriter) {
        await awaitGateBeforeSettlement(
          commandEntered.promise,
          disposal.entered,
          "Execution entered disposal before command dispatch",
        );
        const producer = entry.adapter.resolveTerminalProducer?.();
        expect(
          producer?.handoff(async (producerCompleted) => {
            await producerCompleted;
            await save.wait();
          }),
        ).toBe(true);
        finishCommand.resolve();
        await awaitGateBeforeSettlement(
          save.entered,
          disposal.entered,
          "Execution entered disposal before its terminal save",
        );
        expect(execution.runtimeRelease).not.toHaveBeenCalled();
        expect(sourceSettled).not.toHaveBeenCalled();
        save.resolve();
      }
      await disposal.entered;
      expect(entry.input.retirementRequested).toBe(true);
      expect(getRpcSourceProjectSessionActive(entry)).toBe(false);
      if (prewriter) {
        expect(execution.params.prepared.activeGatewayWorkAdmission?.isActive()).toBe(false);
        expect(isRpcSourceExecuting(entry)).toBe(false);
        expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
      } else {
        expect(sourceSettled).not.toHaveBeenCalled();
        expect(entry.adapter.resolveTerminalProducer?.()).toBeUndefined();
      }
      expect(registration.markExecutionStarted()).toBe(false);
      expect(rpcSourceTesting.get(execution.params.runId)).toBe(entry);
      expectCalls(0, execution.callerRelease, finished);
      if (database) {
        expect(database.isOpen).toBe(true);
      }
      disposal.resolve();
      if (completedCleanupFails) {
        expect(collectNestedErrorCandidates(await observed)).toContain(callbackFault);
        if (publicationFails) {
          expect(collectNestedErrorCandidates(await observed)).toContain(publicationFault);
        }
        expect(database?.isOpen).toBe(false);
        expect(nativeDisposals).toBe(1);
      } else if (outcome === "publication and cleanup failure") {
        expect(collectNestedErrorCandidates(await observed)).toEqual(
          expect.arrayContaining([publicationFault, cleanupFault]),
        );
      } else if (outcome === "publication failure") {
        expect(await observed).toBe(publicationFault);
      } else if (cleanupFails) {
        expect(await observed).toBe(cleanupFault);
      } else {
        await completion;
      }
      expect(rpcSourceTesting.has(execution.params.runId)).toBe(cleanupFails);
      if (cleanupFails) {
        expect(sourceSettled).not.toHaveBeenCalled();
      } else {
        expect(sourceSettled).toHaveBeenCalledOnce();
      }
      expect(execution.callerRelease).toHaveBeenCalledOnce();
    } finally {
      finishCommand.resolve();
      save.resolve();
      disposal.resolve();
      await observed;
      execution.params.prepared.activeGatewayWorkAdmission?.release();
    }
  });

  it("lets a disposer drain its real session without waiting on its own retained execution", async () => {
    const execution = createExecution();
    setRuntimeConfigSnapshot(execution.params.cfg);
    onTestFinished(() => clearRuntimeConfigSnapshot());
    const registration = await bindRegisteredExecution(
      execution,
      "agent:main:self-disposal",
      "self-disposal-session",
    );
    registration.controller.abort();
    const context = createChatAbortContext({
      ...execution.params.context,
      sources: [[execution.params.runId, registration.entry]],
    }) as unknown as GatewayRequestContext;
    execution.params.context = context;
    const { sessionKey, sessionId } = getRpcSourceIdentity(registration.entry);
    const dispatchYield = vi
      .spyOn(agentHandlerHelpers, "yieldAfterAgentAcceptedAck")
      .mockResolvedValue(undefined);
    const disposalEntered = createDeferred();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    execution.runtimeRelease.mockImplementation(async () => {
      disposalEntered.resolve();
      expect(rpcSourceTesting.get(execution.params.runId)).toBe(registration.entry);
      const drain = await prepareSessionLifecycleDrain({
        action: "delete",
        context,
        storePath: expectDefined(
          execution.params.prepared.lifecycleStorePath,
          "admitted lifecycle store",
        ),
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
    const completion = registration.run().then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        disposalEntered.promise,
        completion.then((error) => {
          throw new Error("Execution completed before its lifecycle disposer started", {
            cause: error,
          });
        }),
      ]);
      await vi.advanceTimersByTimeAsync(SESSION_CONTROLLER_DRAIN_TIMEOUT_MS);
      expect(await completion).toBeUndefined();
      expect(rpcSourceTesting.has(execution.params.runId)).toBe(false);
      expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
    } finally {
      await completion;
      vi.useRealTimers();
      dispatchYield.mockRestore();
      execution.params.prepared.activeGatewayWorkAdmission?.release();
    }
  });

  it("selects the exact preparing RPC input and lends its operation to command dispatch", async () => {
    const execution = createExecution();
    const completion = bindFollowupCompletion(execution);
    const source = execution.params.prepared.activeRunAbort.entry!;
    const entered = createDeferred();
    const release = createDeferred();
    dispatchAgentRunFromGateway.mockImplementationOnce(async (dispatch) => {
      expect(source.input.claim?.inputs).toEqual([source.input]);
      expect(getCurrentSessionControllerOwner()).toBe(source.input.claim?.operation);
      expect(source.input.mailbox.entries).toContain(source.input);
      expect(source.input.mailbox.entries).toHaveLength(1);
      entered.resolve();
      await release.promise;
      dispatch.cleanupAbortController();
    });
    const running = startAgentRunExecution(execution.params);
    try {
      await Promise.race([entered.promise, running]);
      expect(dispatchAgentRunFromGateway).toHaveBeenCalledOnce();
      expect(source.input.claim?.released).toBe(false);
    } finally {
      release.resolve();
      await running;
      completion.close();
    }
    expect(source.input.claim?.released).toBe(true);
  });

  it("preserves access across liveness and invalidates creation", async () => {
    const execution = createVisibleExecution();
    execution.params.isNewSession = true;
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
        { reason: "create", accessChanges: expect.any(Number) },
        { reason: "send", accessChanges: 0 },
        { reason: "agent.run.started", accessChanges: 0 },
        { reason: "agent.input.settled", accessChanges: 0 },
      ]);
      expect(notices[0]?.accessChanges).toBeGreaterThan(0);
    } finally {
      publisher.mockRestore();
    }
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
    const runId = execution.params.runId;
    try {
      const { runContext } = await prepareEmbeddedSessionState({
        cfg: execution.params.cfg,
        opts: dispatch.ingressOpts,
        sessionKey: dispatch.ingressOpts.sessionKey,
        sessionId: dispatch.ingressOpts.sessionId ?? "source-session",
        storePath: "/unused/command.sqlite",
        sessionAgentId: "main",
        lifecycleGeneration: getAgentRunLifecycleGeneration(),
        runId,
        executionWorkspaceDir: "/workspace/A",
        watchSkills: false,
        isNewSession: false,
        isSubagentLaneTurn: false,
        suppressVisibleSessionEffects: execution.params.suppressVisibleSessionEffects,
        sessionStateActor: classifySessionStateActor(dispatch.ingressOpts),
      });
      expect(runContext.messageChannel).toBe(testCase.expectedChannel);
      expect(runContext.currentChannelId).toBeUndefined();
    } finally {
      clearAgentRunContext(runId);
    }
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
    expect(dispatchedSnapshot).toBe(
      expectDefined(execution.params.prepared.preparedModelRuntimeLease, "ready session runtime")
        .snapshot,
    );
    const dispatch = dispatchAgentRunFromGateway.mock.calls[0]?.[0];
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
    expectCalls(1, execution.runtimeRelease, execution.callerRelease);
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
      dispatchAgentRunFromGateway.mockResolvedValueOnce(undefined);

      await startAgentRunExecution(execution.params);

      const dispatch = dispatchAgentRunFromGateway.mock.calls[0]?.[0];
      expect(dispatch?.ingressOpts.workspaceDir).toBe(workspaceOverride ?? "/workspace/admitted");
      expectCalls(1, execution.runtimeRelease, execution.callerRelease);
    },
  );

  // Cancelled sources retain their captured identity through disposal. Every
  // successor is a separately reserved source in the same physical store.
  it.each([
    { ending: "aborted", registration: "current" },
    { ending: "failed", registration: "current" },
    { ending: "aborted", registration: "foreign" },
    { ending: "aborted", registration: "absent" },
    { ending: "aborted", registration: "replacement" },
    { ending: "aborted", registration: "controller successor" },
    { ending: "aborted", registration: "session incarnation successor" },
    { ending: "aborted", registration: "operational instance successor" },
    { ending: "aborted", registration: "lifecycle successor" },
  ] as const)(
    "settles an undispatched $ending followup only after cleanup (registration: $registration)",
    async ({ ending, registration }) => {
      const settlement = createGate();
      const execution = createExecution({
        pendingInputSettlement: settlement.wait,
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
      const identity = getRpcSourceIdentity(entry);
      const successor =
        registration !== "current" && registration !== "absent"
          ? createTestRpcSource(
              {
                ...entry.adapter,
                ...identity,
                sessionKey:
                  registration === "foreign" ? "agent:main:unrelated" : identity.sessionKey,
                sessionId:
                  registration === "session incarnation successor"
                    ? "successor-session"
                    : identity.sessionId,
                operationalRunInstance:
                  registration === "replacement" ||
                  registration === "operational instance successor"
                    ? createOperationalRunInstanceRef(execution.params.runId)
                    : entry.adapter.operationalRunInstance,
                lifecycleGeneration:
                  registration === "replacement" || registration === "lifecycle successor"
                    ? "successor-lifecycle"
                    : entry.adapter.lifecycleGeneration,
              },
              execution.params.runId,
              execution.params.prepared.lifecycleStorePath,
            )
          : undefined;
      if (successor) {
        rpcSourceTesting.set(execution.params.runId, successor);
      } else if (registration === "absent") {
        rpcSourceTesting.deleteExpected(execution.params.runId, entry);
      }
      const lostRegistration = successor !== undefined && registration !== "foreign";
      const recovery = createGate();
      const disposal = createGate();
      execution.params.releaseCronContinuationClaimWithRecovery = async () => {
        await recovery.wait();
        return true;
      };
      execution.runtimeRelease.mockImplementation(disposal.wait);
      const replyObserved = vi.fn();
      const reply = owner.take().then((result) => {
        replyObserved(result);
        return result;
      });
      void reply.catch(() => {});
      const finished = vi.fn();
      const completion = startAgentRunExecution(execution.params).then(finished);
      try {
        await Promise.race([recovery.entered, completion]);
        expectCalls(0, dispatchAgentRunFromGateway, execution.params.io.emitFinal);
        expect(execution.params.context.dedupe.size).toBe(0);
        expectCalls(0, replyObserved, execution.abortCleanup);
        recovery.resolve();
        await Promise.race([settlement.entered, completion]);
        expectCalls(0, execution.params.io.emitFinal, execution.abortCleanup);
        expect(execution.params.context.dedupe.size).toBe(0);
        settlement.resolve();
        await Promise.race([disposal.entered, completion]);
        expect(execution.params.io.emitFinal).toHaveBeenCalledOnce();
        expect(execution.params.context.dedupe.size).toBe(1);
        expectCalls(1, execution.abortCleanup, execution.gatewayRelease, execution.runtimeRelease);
        expectCalls(0, execution.callerRelease, replyObserved, finished);
        disposal.resolve();
        await completion;
        expectCalls(1, finished, execution.callerRelease);
        if (successor) {
          expect(rpcSourceTesting.get(execution.params.runId)).toBe(successor);
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
        recovery.resolve();
        settlement.resolve();
        disposal.resolve();
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
      expectCalls(1, execution.abortCleanup, execution.gatewayRelease, execution.runtimeRelease);
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
