import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { it, expect, vi, type MockInstance, type Mock } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { runEmbeddedAgent as executeEmbeddedAgent } from "../agents/embedded-agent.js";
import { registerAgentHarness, getRegisteredAgentHarness } from "../agents/harness/registry.js";
import * as runtimePlugins from "../agents/runtime-plugins.js";
import { installSessionPlacementAdmissionProvider } from "../agents/session-placement-admission.js";
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
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import {
  createGoalChatStartRequest,
  readGoalChatUserMessages,
} from "./server.chat-goal.test-support.js";
import { prepareGatewayReplyRuntimeForTest } from "./test-helpers.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";
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
import { createWorkerSessionTurnPlacementProvider } from "./worker-environments/worker-turn-launcher.js";
import { createWorkerWorkspaceOperationCoordinator } from "./worker-environments/workspace-operation-coordinator.js";

type Scope = { agentId: string; sessionKey: string; sessionId: string; storePath: string };

/** Provider/model transport is simulated; RPC, queue, sharing and SQLite writers are real. */
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
  it.each([
    "continue",
    "preparation-failed",
    "revoked",
    "claim-revoked",
    "claim-reassigned",
  ] as const)(
    "admits native worker Goal input and continuation through current placement (%s)",
    async (mode) => {
      const { sessionKey, sessionId, storePath } = scope();
      const context = getContext();
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
      const baseline = getRuntimeConfig();
      const config: OpenClawConfig = {
        ...baseline,
        plugins: {
          ...baseline.plugins,
          entries: { ...baseline.plugins?.entries, codex: { enabled: true } },
        },
        agents: {
          ...baseline.agents,
          entries: {
            ...baseline.agents?.entries,
            main: { ...baseline.agents?.entries?.main, nativeRuntimeConsent: ["codex"] },
          },
        },
      };
      await prepareGatewayReplyRuntimeForTest({ force: true, config });
      await patchSessionEntryCore(scope(), () => ({
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      }));
      expect(getRegisteredAgentHarness("codex")?.harness.cloudPlacement?.mode).toBe("remote-exec");
      const placements = createWorkerSessionPlacementStore();
      context.workerSessionPlacementService = placements;
      const environment = {
        ...createDispatchEnvironmentFixtures().attached,
        environmentId: "worker-goal-environment",
        ownerEpoch: 7,
        nodeDeviceId: "worker-goal-node",
        sshEndpoint: null,
        attachedSessionIds: [sessionId],
      };
      await advancePlacementFixtureToActive(
        placements,
        openOpenClawStateDatabase(),
        { agentId: "main", sessionKey, sessionId, executionMode: "remote-exec" },
        {
          environmentId: environment.environmentId,
          ownerEpoch: environment.ownerEpoch,
          workerBundleHash: environment.bootstrapReceipt.bundleHash,
          remoteWorkspaceDir: "/worker/goal-workspace",
        },
      );
      const unexpectedTransport = async () => {
        throw new Error("Unexpected external worker operation");
      };
      // Only node/model I/O is synthetic; the launcher owns real SQLite placement claims.
      const provider = createWorkerSessionTurnPlacementProvider({
        placements,
        environments: {
          get: () => environment,
          acquireTurnCredential: unexpectedTransport,
          acknowledgeCredentialDelivery: unexpectedTransport,
          destroy: unexpectedTransport,
          stopTunnel: async () => {},
          startTunnel: async () => ({
            environmentId: environment.environmentId,
            ownerEpoch: environment.ownerEpoch,
            runWorkspaceCommand: async (command) => {
              command.assertCurrent?.();
              expect(JSON.parse(command.input ?? "null")).toEqual({ op: "discover" });
              return {
                stdout: "",
                stderr: "",
                code: 0,
                signal: null,
                killed: false,
                termination: "exit",
              };
            },
            quiesceWorkspace: unexpectedTransport,
            reconcileWorkspace: unexpectedTransport,
            syncWorkspace: unexpectedTransport,
            stop: async () => {},
          }),
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
      const objective = "Finish a native worker checklist";
      const request = createGoalChatStartRequest(scope(), objective, randomUUID());
      const profile = ensureProfileForEmail("worker-goal@example.test");
      const operator = {
        ...client,
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
        internal: {
          authenticatedControlUi: true,
          authenticatedOperator: true,
          isLocalClient: true,
        },
      } satisfies GatewayClient;
      runEmbeddedAgent.mockImplementation(async (params) => {
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
            if (mode === "claim-revoked" || mode === "claim-reassigned") {
              const current = await placements.getAsync(sessionId);
              if (current?.state !== "active") {
                throw new Error("Expected an active worker placement before Goal promotion");
              }
              revokedClaim = projectPlacementTurnClaim(current);
              if (!revokedClaim || !placements.validateTurnClaim(revokedClaim)) {
                throw new Error("Expected a live launcher-owned claim before Goal promotion");
              }
            }
            await params.userTurnTranscriptRecorder?.persistApproved();
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
                  sessionId: params.sessionId,
                  provider: "test",
                  model: "test",
                  agentHarnessId: "codex",
                  usage: { input: 2, output: 1 },
                  lastCallUsage: { input: calls * 10, output: 1 },
                },
              },
            };
          },
          undefined,
          params.preparedRunAdmission?.assertSourceCurrent,
        );
      });
      const starting = rpc("chat.send", request, undefined, operator);
      try {
        await awaitGateBeforeSettlement(
          prepared.promise,
          starting,
          "Worker Goal returned before runtime admission",
        );
        expect(loadSessionEntry(scope())?.goal).toBeUndefined();
        expect(userMessages()).toEqual([]);
        if (mode === "continue") {
          const duplicate = await rpc("chat.send", request, undefined, operator);
          expect(duplicate.mock.calls[0]?.[0]).toBe(false);
          expect(duplicate.mock.calls[0]?.[2]).toMatchObject({
            code: "UNAVAILABLE",
            retryable: true,
          });
          expect(runEmbeddedAgent).toHaveBeenCalledOnce();
        }
        promote.resolve();
        const started = await starting;
        if (mode !== "continue") {
          expect(started.mock.calls[0]?.[0]).toBe(false);
          await waitForDispatchEnd();
          expect(loadSessionEntry(scope())?.goal).toBeUndefined();
          expect(userMessages()).toEqual([]);
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
            const changed = await rpc(
              "chat.send",
              { ...request, message: "A different objective" },
              undefined,
              operator,
            );
            expect(changed.mock.calls[0]?.[0]).toBe(false);
            expect(changed.mock.calls[0]?.[2]).toMatchObject({
              code: "INVALID_REQUEST",
              details: { reason: "goal-operation-conflict" },
            });
            expect(runEmbeddedAgent).toHaveBeenCalledOnce();
            const retried = await rpc("chat.send", request, undefined, operator);
            expect(retried.mock.calls[0]).toEqual([
              true,
              expect.objectContaining({ status: "started", action: "start" }),
              undefined,
              expect.anything(),
            ]);
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
        expect(started.mock.calls[0]).toEqual([
          true,
          expect.objectContaining({
            status: "started",
            action: "start",
            goalId: expect.any(String),
          }),
          undefined,
          expect.anything(),
        ]);
        await waitForDispatchEnd();
        const first = loadSessionEntry(scope())!.goal!;
        expect(first.status).toBe("paused");
        expect(first.continuationTurns).toBe(0);
        expect(userMessages()).toHaveLength(1);
        const resumed = await rpc(
          "sessions.goal.update",
          {
            sessionKey,
            sessionId,
            goalId: first.id,
            action: "resume",
            operationId: "resume-native-goal",
            issuedAtMs: Date.now(),
          },
          undefined,
          operator,
        );
        expect(resumed.mock.calls[0]).toEqual([
          true,
          expect.objectContaining({ action: "resume", goalId: first.id }),
          undefined,
          expect.anything(),
        ]);
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
        const replay = await rpc("chat.send", request, undefined, operator);
        expect(replay.mock.calls[0]?.[1]).toMatchObject({ replayed: true, goalId: first.id });
        expect(runEmbeddedAgent).toHaveBeenCalledTimes(4);
      } finally {
        promote.resolve();
        await starting;
        await waitForDispatchEnd();
        commitAdmission.mockRestore();
        releasePlacement();
        loadNative.mockRestore();
        if (replacementClaim && placements.validateTurnClaim(replacementClaim)) {
          await placements.releaseTurn(replacementClaim);
        }
        const active = await placements.getAsync(sessionId);
        expect(active?.state).toBe("active");
        if (active?.state === "active") {
          const draining = await placements.startDrain({
            sessionId,
            environmentId: environment.environmentId,
            ownerEpoch: environment.ownerEpoch,
            expectedGeneration: active.generation,
          });
          const reconciling = await placements.startReconcile({
            sessionId,
            environmentId: environment.environmentId,
            ownerEpoch: environment.ownerEpoch,
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
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message:
            "Error: Goal start or resume requires an idle built-in local session with recoverable history or a supported Codex cloud-worker session.",
        }),
      );
      expect(loadSessionEntry(scope())?.goal).toBeUndefined();
      expect(userMessages()).toEqual([]);
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    } finally {
      clearAgentRunContext(runId);
    }
  });
}
