import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { it, expect, vi, type MockInstance, type Mock } from "vitest";
import { WORKER_TURN_ADMISSION_PROTOCOL_FEATURE } from "../../packages/gateway-protocol/src/schema/worker-turn-admission.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { runEmbeddedAgent as executeEmbeddedAgent } from "../agents/embedded-agent.js";
import { registerAgentHarness, getRegisteredAgentHarness } from "../agents/harness/registry.js";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import * as runtimePlugins from "../agents/runtime-plugins.js";
import { installSessionPlacementAdmissionProvider } from "../agents/session-placement-admission.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { captureSessionControllerSettlement } from "../sessions/session-controller.lifecycle.js";
import { listRpcSourceEntries } from "../sessions/session-controller.rpc-sources.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { captureEnv } from "../test-utils/env.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import {
  createGoalChatStartRequest,
  createGoalChatRunGate,
  readGoalChatUserMessages,
} from "./server.chat-goal.test-support.js";
import { gatewayProfile } from "./server/client-fixtures.test-support.js";
import { prepareGatewayReplyRuntimeForTest } from "./test-helpers.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import { result as workerCommandResult } from "./worker-environments/bootstrap.test-support.js";
import { createDispatchEnvironmentFixtures } from "./worker-environments/placement-dispatch-test-fixtures.js";
import {
  projectPlacementTurnClaim,
  type WorkerSessionTurnClaim,
} from "./worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import {
  advancePlacementFixtureToActive,
  createPlacementTurnClaimFixtureOps,
} from "./worker-environments/placement-test-fixtures.js";
import { admitWorkerTurnInput } from "./worker-environments/placement-turn-claim-events.js";
import { createWorkerSessionPlacementGate } from "./worker-environments/placement-worker-gate.js";
import type { WorkerTurnTunnelHandle } from "./worker-environments/tunnel-contract.js";
import { createWorkerSessionTurnPlacementProvider } from "./worker-environments/worker-turn-launcher.js";
import {
  createWorkerTurnTunnel,
  credential,
} from "./worker-environments/worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./worker-environments/workspace-operation-coordinator.js";

type Scope = { agentId: string; sessionKey: string; sessionId: string; storePath: string };

/** RPC, queue, sharing and SQLite are real; only provider/node transport is simulated. */
export function registerWorkerGoalChatCases(
  scope: () => Scope,
  runEmbeddedAgent: MockInstance<typeof executeEmbeddedAgent>,
  rpc: (
    method: "chat.send" | "sessions.goal.update",
    params: Record<string, unknown>,
    onResponse?: RespondFn,
    client?: GatewayClient,
  ) => Promise<Mock<RespondFn>>,
  getContext: () => GatewayRequestContext,
  client: GatewayClient,
) {
  const userMessages = () => readGoalChatUserMessages(scope());
  const expectNoGoalInput = () => {
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
    expect(userMessages()).toEqual([]);
  };
  const expectAccepted = (response: Mock<RespondFn>, payload: Record<string, unknown>) => {
    expect(response.mock.calls[0]).toEqual([
      true,
      expect.objectContaining(payload),
      undefined,
      expect.anything(),
    ]);
  };
  const codexModes = [
    "continue",
    "preparation-failed",
    "revoked",
    "claim-revoked",
    "claim-reassigned",
  ] as const;
  it.each([
    ...codexModes.map((mode) => ({ runtime: "codex" as const, mode })),
    { runtime: "openclaw" as const, mode: "continue" as const },
    { runtime: "openclaw" as const, mode: "preparation-failed" as const },
    { runtime: "openclaw" as const, mode: "claim-revoked" as const },
    { runtime: "openclaw" as const, mode: "hook-block-start" as const },
    { runtime: "openclaw" as const, mode: "hook-throw-start" as const },
    { runtime: "openclaw" as const, mode: "hook-block-resume" as const },
    { runtime: "openclaw" as const, mode: "hook-throw-resume" as const },
  ])(
    "admits $runtime worker Goal input and continuation through current placement ($mode)",
    async ({ runtime, mode }) => {
      const { sessionKey, sessionId, storePath } = scope();
      const context = getContext();
      const hookStart = mode === "hook-block-start" || mode === "hook-throw-start";
      const hookResume = mode === "hook-block-resume" || mode === "hook-throw-resume";
      const implicitRuntime = runtime === "openclaw" && mode === "continue";
      const policyEnv = captureEnv([
        "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
        "OPENCLAW_BUNDLED_PLUGINS_DIR",
        "OPENAI_API_KEY",
      ]);
      using _ = { [Symbol.dispose]: () => policyEnv.restore() };
      if (implicitRuntime) {
        delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
        delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
        process.env.OPENAI_API_KEY = "synthetic-goal-api-key";
      }
      const waitForDispatchEnd = async () => {
        await captureSessionControllerSettlement({
          scope: storePath,
          identities: [sessionKey, sessionId],
        });
        expect(
          listRpcSourceEntries().some(
            ([, source]) => source.input.target?.storeScope === storePath,
          ),
        ).toBe(false);
      };
      registerAgentHarness({
        id: "codex",
        label: "Codex fixture",
        cloudPlacement: { mode: "remote-exec" },
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: async () => {
          throw new Error("provider transport is simulated");
        },
      });
      const registered = getRegisteredAgentHarness("codex")!;
      getTestPluginRegistry().agentHarnesses.push({
        pluginId: "codex",
        source: "fixture",
        harness: registered.harness,
      });
      const loadNative = vi
        .spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle")
        .mockReturnValue(getTestPluginRegistry());
      const loadNativeAsync = vi
        .spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandleAsync")
        .mockResolvedValue(getTestPluginRegistry());
      const config: OpenClawConfig = structuredClone(getRuntimeConfig());
      config.plugins ??= {};
      config.plugins.entries = { ...config.plugins.entries, codex: { enabled: true } };
      config.agents ??= {};
      config.agents.entries = {
        ...config.agents.entries,
        main: { ...config.agents.entries?.main, nativeRuntimeConsent: ["codex"] },
      };
      if (runtime === "openclaw") {
        config.agents.defaults = {
          ...config.agents.defaults,
          model: { primary: implicitRuntime ? "openai/gpt-5.5" : "goal-test/test-model" },
        };
        if (implicitRuntime) {
          delete config.models;
        } else {
          config.models = {
            providers: {
              "goal-test": {
                api: "openai-responses",
                baseUrl: "https://goal-model.example.test/v1",
                apiKey: "synthetic-goal-key",
                models: [modelDefinition("test-model")],
              },
            },
          };
        }
      }
      await prepareGatewayReplyRuntimeForTest({ force: true, config });
      await patchSessionEntryCore(scope(), () => ({
        agentHarnessId: implicitRuntime ? undefined : runtime,
        modelSelectionLocked: !implicitRuntime,
      }));
      if (implicitRuntime) {
        expect(
          resolveEffectiveAgentRuntime({
            cfg: config,
            agentId: "main",
            sessionKey,
            provider: "openai",
            modelId: "gpt-5.5",
            sessionEntry: loadSessionEntry(scope()),
          }),
        ).toBe("codex");
      }
      const { hook, installHook, removeHook } = createGoalChatRunGate(
        mode === "hook-throw-start" || mode === "hook-throw-resume",
      );
      if (hookStart) {
        installHook();
      }
      const placements = createWorkerSessionPlacementStore();
      context.workerSessionPlacementService = placements;
      const environment = {
        ...createDispatchEnvironmentFixtures().attached,
        environmentId: "worker-goal-environment",
        ownerEpoch: 7,
        nodeDeviceId: "worker-goal-node",
        sshEndpoint: null,
        attachedSessionIds: [sessionId],
        bootstrapReceipt: {
          ...createDispatchEnvironmentFixtures().attached.bootstrapReceipt,
          protocolFeatures: [
            ...createDispatchEnvironmentFixtures().attached.bootstrapReceipt.protocolFeatures,
            WORKER_TURN_ADMISSION_PROTOCOL_FEATURE,
          ],
        },
      };
      const placementOwner = {
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
      };
      await advancePlacementFixtureToActive(
        placements,
        openOpenClawStateDatabase(),
        {
          agentId: "main",
          sessionKey,
          sessionId,
          executionMode: runtime === "codex" ? "remote-exec" : "worker-turn",
        },
        {
          ...placementOwner,
          workerBundleHash: environment.bootstrapReceipt.bundleHash,
          remoteWorkspaceDir: "/worker/goal-workspace",
        },
      );
      const unexpectedTransport = async () => {
        throw new Error("Unexpected external worker operation");
      };
      const provider = createWorkerSessionTurnPlacementProvider({
        placements,
        environments: {
          get: () => environment,
          ensureRetainedRunning: unexpectedTransport,
          inspectTurnLease: async ({ assertCurrent }) => assertCurrent(),
          acquireTurnCredential: async () => ({
            ...credential(),
            ...placementOwner,
            sessionId,
            bundleHash: environment.bootstrapReceipt.bundleHash,
          }),
          acknowledgeCredentialDelivery: async () => true,
          createGatewayTools: async ({ prepareTools }) => prepareTools?.([]) ?? [],
          destroy: unexpectedTransport,
          stopTunnel: async () => {},
          startTunnel: async () =>
            runtime === "openclaw"
              ? createWorkerTurnTunnel({
                  ...placementOwner,
                  launchTurn: launchWorkerTurn,
                  reconcileWorkspace: unexpectedTransport,
                })
              : {
                  ...placementOwner,
                  runWorkspaceCommand: async (command) => {
                    command.assertCurrent?.();
                    expect(JSON.parse(command.input ?? "null")).toEqual({ op: "discover" });
                    return workerCommandResult();
                  },
                  quiesceWorkspace: unexpectedTransport,
                  reconcileWorkspace: unexpectedTransport,
                  syncWorkspace: unexpectedTransport,
                  stop: async () => {},
                },
        },
        resolveWorkspace: async () => ({
          kind: "device-folder",
          deviceId: environment.nodeDeviceId,
          path: "/worker/goal-workspace",
        }),
        workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
        waitForAdmissionNode: unexpectedTransport,
        reconcileActivePlacement: unexpectedTransport,
        redispatchPlacement: unexpectedTransport,
      });
      const releasePlacement = installSessionPlacementAdmissionProvider(provider);
      const modelExecuted = vi.fn();
      let revokedClaim: WorkerSessionTurnClaim | undefined;
      let replacementClaim: WorkerSessionTurnClaim | undefined;
      const claimOps = createPlacementTurnClaimFixtureOps(
        openOpenClawStateDatabase(),
        placements.workspaceResultInstanceId(),
      );
      let claimChangedAtCommit = false;
      // Change the real claim in the synchronous native COMMIT callback; retain all source checks.
      const commitAdmission = sqliteWorkerOwnerProbe.admission(
        workerAdmission,
        (request, grant, admit) => {
          const publication = isRecord(request.facts) ? request.facts.publication : undefined;
          if (
            revokedClaim &&
            !claimChangedAtCommit &&
            request.stage === "commit" &&
            isRecord(publication) &&
            publication.kind === "session-actor-admission" &&
            publication.final === true &&
            isRecord(publication.publication) &&
            publication.publication.kind === "session-turn"
          ) {
            claimChangedAtCommit = true;
            claimOps.cancelWorkspaceResultAndReleaseTurn(revokedClaim, {
              reason: "node-disconnect",
            });
            if (mode === "claim-reassigned") {
              replacementClaim = claimOps.claimTurn({
                agentId: "main",
                sessionKey,
                sessionId,
                claimId: "replacement-goal-claim",
                runId: "replacement-goal-run",
                owner: revokedClaim.owner,
              });
            }
          }
          admit(request, grant);
        },
      );
      const prepared = createDeferred();
      const promote = createDeferred();
      const request = createGoalChatStartRequest(
        scope(),
        "Finish a native worker checklist",
        randomUUID(),
      );
      const profile = ensureProfileForEmail("worker-goal@example.test");
      const operator = {
        ...client,
        authenticatedUserProfile: gatewayProfile(profile.id),
        internal: {
          authenticatedControlUi: true,
          authenticatedOperator: true,
          isLocalClient: true,
        },
      } satisfies GatewayClient;
      const send = (input = request) => rpc("chat.send", input, undefined, operator);
      let input: Parameters<typeof executeEmbeddedAgent>[0];
      async function beforeModel() {
        if (mode === "claim-revoked" || mode === "claim-reassigned") {
          const current = await placements.getAsync(sessionId);
          if (current?.state !== "active") {
            throw new Error("Expected active worker before Goal promotion");
          }
          revokedClaim = projectPlacementTurnClaim(current);
          if (!revokedClaim || !placements.validateTurnClaim(revokedClaim)) {
            throw new Error("Expected live worker claim");
          }
        }
      }
      async function runModel() {
        const calls = runEmbeddedAgent.mock.calls.length;
        expect(loadSessionEntry(scope())?.goal?.status).toBe("active");
        modelExecuted();
        if (calls === 1 || calls === 4 || mode === "preparation-failed") {
          await patchSessionEntryCore(scope(), (entry) => ({
            goal: entry.goal && { ...entry.goal, status: calls === 1 ? "paused" : "complete" },
          }));
        }
        return {
          payloads: [{ text: "Checkpoint reached." }],
          meta: {
            durationMs: 1,
            stopReason: "end_turn",
            agentMeta: {
              sessionId: input.sessionId,
              provider: "test",
              model: "test",
              agentHarnessId: runtime,
              usage: { input: 2, output: 1 },
              lastCallUsage: { input: calls * 10, output: 1 },
            },
          },
        };
      }
      async function launchWorkerTurn(launch: Parameters<WorkerTurnTunnelHandle["launchTurn"]>[0]) {
        launch.onDispatchReady?.();
        if (runEmbeddedAgent.mock.calls.length === 1) {
          expectNoGoalInput();
        }
        if (runEmbeddedAgent.mock.calls.length === 2 && mode === "continue") {
          expect(loadSessionEntry(scope())?.goal?.status).toBe("paused");
        }
        await beforeModel();
        const admitted = await admitWorkerTurnInput(
          {
            ...placementOwner,
            sessionId,
            runId: input.runId,
            turnClaim: launch.turnClaim,
            credentialHash: credential().deliveryId,
            bundleHash: environment.bootstrapReceipt.bundleHash,
            rpcSetVersion: 1,
            protocolFeatures: environment.bootstrapReceipt.protocolFeatures,
            credentialExpiresAtMs: Date.now() + 60_000,
          },
          {
            runEpoch: environment.ownerEpoch,
            systemPrompt: launch.plan.assignment.systemPrompt ?? "",
            prompt: input.prompt,
            messages: [],
          },
          () => placements.validateTurnClaim(launch.turnClaim),
        );
        expect(admitted.ok).toBe(true);
        if (admitted.ok && admitted.result.outcome === "block") {
          return workerCommandResult();
        }
        expect(admitted).toMatchObject({ ok: true, result: { outcome: "allow" } });
        await runModel();
        const manager = await SessionManager.openAsync({
          ...scope(),
        });
        const leaf = await manager.appendMessageAsync(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "Checkpoint reached." }],
            timestamp: Date.now(),
            usage: {
              input: runEmbeddedAgent.mock.calls.length * 10,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: runEmbeddedAgent.mock.calls.length * 10 + 1,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          }),
        );
        const seq = launch.plan.assignment.transcript.nextSeq;
        await createWorkerSessionPlacementGate(placements).updateAckCursors({
          claim: launch.turnClaim,
          transcriptSeq: seq,
          liveSeq: launch.plan.assignment.liveEvents.nextSeq,
        });
        return workerCommandResult({
          stdout: JSON.stringify({
            status: "completed",
            transcriptLeafId: leaf,
            transcriptNextSeq: seq + 1,
          }),
        });
      }
      runEmbeddedAgent.mockImplementation(async (params) => {
        input = params;
        prepared.resolve();
        await promote.promise;
        if (mode === "preparation-failed" && runEmbeddedAgent.mock.calls.length === 1) {
          throw new Error("Worker setup declined input");
        }
        if (mode === "revoked") {
          operator.invalidated = true;
        }
        const calls = runEmbeddedAgent.mock.calls.length;
        if (calls > 4) {
          throw new Error("Completed Goal continued again");
        }
        const target = { agentId: "main", sessionKey, sessionId: params.sessionId, storePath };
        return provider.executeTurn(
          { ...target, runId: params.runId },
          {
            ...params,
            sessionFile: sessionKey,
            sessionTarget: target,
            skillsSnapshot: undefined,
            explicitSkillSelections: undefined,
          },
          async () => {
            await beforeModel();
            await params.userTurnTranscriptRecorder?.persistApproved();
            return await runModel();
          },
          undefined,
          params.preparedRunAdmission?.assertSourceCurrent,
        );
      });
      const starting = send();
      try {
        await awaitGateBeforeSettlement(
          prepared.promise,
          starting,
          "Worker Goal returned before runtime admission",
        );
        expectNoGoalInput();
        if (mode === "continue") {
          const duplicate = await send();
          expect(duplicate.mock.calls[0]?.[0]).toBe(false);
          expect(duplicate.mock.calls[0]?.[2]).toMatchObject({
            code: "UNAVAILABLE",
            retryable: true,
          });
          expect(runEmbeddedAgent).toHaveBeenCalledOnce();
        }
        promote.resolve();
        const started = await starting;
        if (hookStart) {
          expect(started.mock.calls[0]?.[0]).toBe(false);
          await waitForDispatchEnd();
          expect(hook).toHaveBeenCalledOnce();
          expect(loadSessionEntry(scope())?.goal).toBeUndefined();
          expect(JSON.stringify(userMessages())).not.toContain(request.message);
          expect(modelExecuted).not.toHaveBeenCalled();
          removeHook();
          context.dedupe.clear();
          const rejectedReplay = await send();
          expect(rejectedReplay.mock.calls[0]?.[0]).toBe(false);
          expect(loadSessionEntry(scope())?.goal).toBeUndefined();
          expect(modelExecuted).not.toHaveBeenCalled();
          return;
        }
        if (mode !== "continue" && !hookResume) {
          expect(started.mock.calls[0]?.[0]).toBe(false);
          await waitForDispatchEnd();
          expectNoGoalInput();
          if (mode === "claim-revoked" || mode === "claim-reassigned") {
            expect(claimChangedAtCommit).toBe(true);
            expect(revokedClaim).toBeDefined();
            expect(revokedClaim && placements.validateTurnClaim(revokedClaim)).toBe(false);
            expect(modelExecuted).not.toHaveBeenCalled();
            if (mode === "claim-reassigned") {
              expect(replacementClaim && placements.validateTurnClaim(replacementClaim)).toBe(true);
            }
          }
          if (mode === "preparation-failed") {
            const changed = await send({ ...request, message: "A different objective" });
            expect(changed.mock.calls[0]?.[0]).toBe(false);
            expect(changed.mock.calls[0]?.[2]).toMatchObject({
              code: "INVALID_REQUEST",
              details: { reason: "goal-operation-conflict" },
            });
            expect(runEmbeddedAgent).toHaveBeenCalledOnce();
            const retried = await send();
            expectAccepted(retried, { status: "started", action: "start" });
            await waitForDispatchEnd();
            expect(loadSessionEntry(scope())?.goal).toMatchObject({
              status: "complete",
              continuationTurns: 0,
            });
            expect(userMessages()).toHaveLength(1);
            expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
          }
          return;
        }
        expectAccepted(started, {
          status: "started",
          action: "start",
          goalId: expect.any(String),
        });
        await waitForDispatchEnd();
        const first = loadSessionEntry(scope())!.goal!;
        expect(first).toMatchObject({ status: "paused", continuationTurns: 0 });
        expect(userMessages()).toHaveLength(1);
        const resumeRequest = {
          sessionKey,
          sessionId,
          goalId: first.id,
          action: "resume",
          operationId: randomUUID(),
          issuedAtMs: Date.now(),
        };
        if (hookResume) {
          installHook();
        }
        const resumed = await rpc("sessions.goal.update", resumeRequest, undefined, operator);
        if (hookResume) {
          expect(resumed.mock.calls[0]?.[0]).toBe(false);
          await waitForDispatchEnd();
          expect(hook).toHaveBeenCalledOnce();
          expect(loadSessionEntry(scope())?.goal).toEqual(first);
          expect(modelExecuted).toHaveBeenCalledOnce();
          removeHook();
          context.dedupe.clear();
          const rejectedReplay = await rpc(
            "sessions.goal.update",
            resumeRequest,
            undefined,
            operator,
          );
          expect(rejectedReplay.mock.calls[0]?.[0]).toBe(false);
          expect(loadSessionEntry(scope())?.goal).toEqual(first);
          const retry = await rpc(
            "sessions.goal.update",
            { ...resumeRequest, operationId: randomUUID(), issuedAtMs: Date.now() },
            undefined,
            operator,
          );
          expectAccepted(retry, { action: "resume", goalId: first.id });
          expect(retry.mock.calls[0]?.[1]).not.toHaveProperty("replayed", true);
          expect((await waitForGatewayActiveWork(30_000)).drained).toBe(true);
          expect(loadSessionEntry(scope())?.goal?.status).toBe("complete");
          expect(modelExecuted.mock.calls.length).toBeGreaterThan(1);
          return;
        }
        expectAccepted(resumed, { action: "resume", goalId: first.id });
        expect((await waitForGatewayActiveWork(30_000)).drained).toBe(true);
        expect(loadSessionEntry(scope())?.goal).toMatchObject({
          id: first.id,
          status: "complete",
          continuationTurns: 2,
        });
        expect(runEmbeddedAgent.mock.calls[2]?.[0].inputProvenance).toEqual({
          kind: "internal_system",
          sourceTool: "session_goal_continue",
        });
        expect(loadSessionEntry(scope())?.goal?.tokensUsed).toBeGreaterThan(0);
        expect(runEmbeddedAgent).toHaveBeenCalledTimes(4);
        expect(modelExecuted).toHaveBeenCalledTimes(4);
        expect(userMessages()).toHaveLength(2);
        context.dedupe.clear();
        const replay = await send();
        expect(replay.mock.calls[0]?.[1]).toMatchObject({ replayed: true, goalId: first.id });
        expect(runEmbeddedAgent).toHaveBeenCalledTimes(4);
      } finally {
        promote.resolve();
        await starting;
        await waitForDispatchEnd();
        commitAdmission.mockRestore();
        removeHook();
        releasePlacement();
        loadNative.mockRestore();
        loadNativeAsync.mockRestore();
        if (replacementClaim && placements.validateTurnClaim(replacementClaim)) {
          await placements.releaseTurn(replacementClaim);
        }
        const active = await placements.getAsync(sessionId);
        const lostWorkerClaim = runtime === "openclaw" && mode === "claim-revoked";
        expect(active?.state).toBe(lostWorkerClaim ? "failed" : "active");
        if (active?.state === "failed") {
          // A launched worker that loses its claim remains failed under the existing owner.
          expect(modelExecuted).not.toHaveBeenCalled();
          expectNoGoalInput();
          await placements.retireSessionPlacementAsync({
            sessionId,
            expectedState: "failed",
            expectedGeneration: active.generation,
          });
        }
        if (active?.state === "active") {
          const draining = await placements.startDrain({
            sessionId,
            ...placementOwner,
            expectedGeneration: active.generation,
          });
          const reconciling = await placements.startReconcile({
            sessionId,
            ...placementOwner,
            expectedGeneration: draining.generation,
          });
          const reclaimed = await placements.transition({
            sessionId,
            from: "reconciling",
            to: "reclaimed",
            expectedGeneration: reconciling.generation,
          });
          await placements.retireSessionPlacementAsync({
            sessionId,
            expectedState: "reclaimed",
            expectedGeneration: reclaimed.generation,
          });
        }
      }
    },
  );
  it.each([
    { caseName: "the existing session is busy", busy: true, entry: {} },
    {
      caseName: "the session used the native Codex harness",
      entry: { agentHarnessId: "codex" },
    },
  ])("leaves no Goal or turn when $caseName", async ({ entry, busy }) => {
    const { sessionKey, sessionId } = scope();
    await patchSessionEntryCore(scope(), () => entry);
    const runId = "existing-goal-session-run";
    if (busy) {
      registerAgentRunContext(runId, {
        sessionKey,
        sessionId,
        agentId: "main",
        projectSessionActive: true,
      });
    }
    try {
      const result = await rpc(
        "chat.send",
        createGoalChatStartRequest(scope(), "Finish the release checklist", randomUUID()),
      );
      expect(result).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expectNoGoalInput();
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    } finally {
      clearAgentRunContext(runId);
    }
  });
}
