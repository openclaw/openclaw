import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { resolveAgentRunContext } from "../../agents/command/run-context.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  observeGatewayToolCallerOwner,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import type { SessionEntry } from "../../config/sessions.js";
import { isWebchatClient } from "../../utils/message-channel.js";
import { resolveAgentDeliveryPhase } from "./agent-delivery-phase.js";
import { startAgentRunExecution } from "./agent-run-execution-phase.js";
import type { AgentTurnPrincipal } from "./types.js";

const dispatchAgentRunFromGateway = vi.hoisted(() => vi.fn());

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

describe("startAgentRunExecution Gateway ownership", () => {
  it("records the native Gateway owner on the real post-admission callback", async () => {
    const execution = createExecution();
    // The observation follows resolver identity and must never invoke it.
    execution.params.context.resolveGatewayContext = () => undefined;
    const admission = prepareSystemAgentRunAdmission({}, "native-callback", "test", "fixture");
    try {
      const admitted = await admission.admit("embedded");
      dispatchAgentRunFromGateway.mockImplementationOnce(async (dispatch) => {
        await dispatch.ingressOpts.onAdmittedRunContext(admitted);
        const projected = { agentId: "test", sessionKey: "fixture", runId: "native-callback" };
        const caller = createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          ...projected,
        });
        await withGatewayToolCallerIdentity(caller, async () => {
          expect(observeGatewayToolCallerOwner(projected)).toBe("match");
        });
      });
      await startAgentRunExecution(execution.params);
      expect(dispatchAgentRunFromGateway).toHaveBeenCalledOnce();
    } finally {
      admission.close();
    }
  });
  beforeEach(() => dispatchAgentRunFromGateway.mockReset());

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
