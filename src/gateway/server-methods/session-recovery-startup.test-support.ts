import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi, onTestFinished, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as attemptExecution from "../../agents/command/attempt-execution.runtime.js";
import { makeAttemptResult } from "../../agents/embedded-agent-runner/run.overflow-compaction.fixture.js";
import type { AgentHarnessV2 } from "../../agents/harness/types.js";
import {
  createOriginalIssuerFixture,
  acceptOriginalIssuerTurn,
  interruptOriginalNoGoalTurn,
  assertRecoveredOriginalInput,
  readIssuerFixtureHistory,
} from "../../agents/main-session-recovery/main-session-recovery-original-issuer.test-support.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "../../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import {
  scheduleRestartAbortedMainSessionRecovery,
  recoverRestartAbortedMainSessions,
} from "../../agents/main-session-recovery/main-session-restart-recovery-runtime.js";
import { mainSessionRecoveryLog } from "../../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import * as restartRecoveryStore from "../../agents/main-session-recovery/main-session-restart-recovery-store.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionGoal } from "../../config/sessions/types.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGatewayInstanceRuntime } from "../server-instance-runtime.js";
import type { GatewayInstanceAgentDispatchOptions } from "../server-instance-runtime.types.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { SharedGatewaySessionGenerationState } from "../server-shared-auth-generation.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import {
  prepareGoalRecoveryNativeFixture,
  type StartupNativeEffect,
} from "./session-goal-recovery-native.test-support.js";
import type { RecoveryPreparedScenario } from "./session-recovery-dispatch.test-support.js";
import { prepareOriginalStartupGoal } from "./session-recovery-goal.test-support.js";

export async function exerciseNativeStartup(
  nativeAttempt: Mock<AgentHarnessV2["runAttempt"]>,
  mode: "current" | "revoked" | "revoked-after-disposal" | "revoked-after-read",
  intent: "turn" | "goal" = "turn",
  source: "reclaimed" | "failed" | "failed-cleanup" = "reclaimed",
  preparedScenario?: RecoveryPreparedScenario,
  delayedOriginalResult = false,
  nativeEffect?: StartupNativeEffect,
) {
  let stage = "fixture";
  onTestFinished(() => console.info("[startup-dispatch-proof]", { stage }));
  await withOpenClawTestState({ label: "startup-native-worker" }, async (state) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    vi.stubEnv("GH_CONFIG_DIR", state.statePath("gh"));
    for (const key of [
      "GH_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ]) {
      vi.stubEnv(key, undefined);
    }
    const fixture = await createOriginalIssuerFixture(state, 0, "current grant", true);
    const originalIssuer = expectDefined(
      fixture.original!.authority.captureRestartRecoveryIssuer?.(),
      "original authenticated startup issuer",
    );
    expect(originalIssuer).toMatchObject({
      profileId: fixture.profile.id,
      factoryActor: { host: "microsoft.ghe.com", accountId: 700100 },
      assignedRole: "engineer",
      device: { deviceId: fixture.deviceId },
      authPrincipal: {
        role: "operator",
        verifiedIdentity: "github:microsoft.ghe.com:700100",
        authMethod: "trusted-proxy",
      },
    });
    const target = { agentId: "main", sessionKey: "agent:main:startup-native" };
    const sessionId = "startup-native-session";
    const originalRunId = "accepted-before-startup";
    let originalGoal: SessionGoal | undefined;
    let originalHistory: Awaited<ReturnType<typeof readIssuerFixtureHistory>> = [];
    const workerRoot = state.path("synthetic-worker");
    await fs.mkdir(workerRoot, { recursive: true });
    const native = await prepareGoalRecoveryNativeFixture(
      fixture,
      target,
      sessionId,
      workerRoot,
      true,
      source !== "reclaimed",
      undefined,
      preparedScenario,
      delayedOriginalResult,
      mode === "revoked-after-read"
        ? async () => {
            await setCanonicalUserProfileRole(fixture.profile.id, "revoked");
          }
        : undefined,
      nativeEffect !== undefined,
    );
    stage = "prepared-worker";
    await state.writeConfig(fixture.cfg);
    if (source === "reclaimed") {
      await fs.writeFile(path.join(native.remoteWorkspaceDir, "accepted.txt"), "accepted marker");
    }
    if (mode === "revoked-after-disposal") {
      expectDefined(native.failedRecovery, "canonical failed-source recovery").setAfterDestroy(
        async () => {
          await setCanonicalUserProfileRole(fixture.profile.id, "revoked");
        },
      );
    }
    await replaceSessionEntry(target, {
      sessionId,
      lifecycleRevision: "startup-native-lifecycle",
      status: "done",
      updatedAt: Date.now(),
      createdActor: { type: "human", source: "profile", id: fixture.profile.id },
      repositoryWorkspaceId: native.repository.workspaceId,
      ...(intent === "goal"
        ? {
            totalTokens: 100,
            totalTokensFresh: true,
            totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
          }
        : {}),
    });
    const entered = createDeferred();
    let originalAttemptEntered = false;
    const interrupt = createDeferred();
    const completed = createDeferred();
    let effects = 0;
    let proofsBeforeAutomaticDisposal: number | undefined;
    const expectedEffects =
      mode === "current" &&
      preparedScenario !== "unknown-claim" &&
      preparedScenario !== "target-replaced"
        ? 1
        : 0;
    const warnings = vi.spyOn(mainSessionRecoveryLog, "warn");
    const recover = restartRecoveryStore.recoverStore;
    vi.spyOn(restartRecoveryStore, "recoverStore").mockImplementation(async (...args) => {
      const result = await recover(...args);
      if (
        mode !== "current" ||
        preparedScenario === "unknown-claim" ||
        result.failed > 0 ||
        result.skipped > 0 ||
        effects > 0
      ) {
        completed.resolve();
      }
      return result;
    });
    let retainedGuard: (() => void) | undefined;
    let attemptError: string | undefined;
    const runAttempt = attemptExecution.runAgentAttempt;
    vi.spyOn(attemptExecution, "runAgentAttempt").mockImplementation(async (params) => {
      if (params.runId === originalRunId) {
        originalAttemptEntered = true;
        entered.resolve();
        await interrupt.promise;
        throw createAgentRunRestartAbortError();
      }
      try {
        const result = await runAttempt(params);
        return result;
      } catch (error) {
        if (delayedOriginalResult) {
          completed.resolve();
        }
        attemptError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    });
    nativeAttempt.mockImplementation(async (params) => {
      expect(["current", "revoked-after-read"]).toContain(mode);
      const scope = expectDefined(getPluginRuntimeGatewayRequestScope(), "native placement scope");
      const authority = expectDefined(
        getGatewayToolCallerIdentity()?.operatorAuthority ??
          scope.client?.internal?.operatorRunAuthority,
        "restored original issuer",
      );
      expect(authority.profileId).toBe(fixture.profile.id);
      expect(authority.scopes).toEqual(["operator.read", "operator.write"]);
      expect(authority.captureRestartRecoveryIssuer?.()).toEqual(originalIssuer);
      expect(authority.modelPolicy?.allows({ provider: "openai", model: "allowed" })).toBe(true);
      expect(authority.modelPolicy?.allows({ provider: "openai", model: "other" })).toBe(false);
      expect(params.provider).toBe("openai");
      expect(params.modelId).toBe("allowed");
      expect(params.sessionId).toBe(sessionId);
      expect(params.sessionKey).toBe(target.sessionKey);
      expect(params.runId).not.toBe(originalRunId);
      if (originalGoal) {
        expect(loadSessionEntry(target)?.goal).toMatchObject({
          id: originalGoal.id,
          status: "active",
          objective: "Finish the originally accepted Goal",
          tokenStart: 100,
          tokensUsed: 80,
          tokenBudget: 500,
          continuationTurns: 3,
        });
      } else {
        expect(loadSessionEntry(target)?.goal).toBeUndefined();
      }
      try {
        await native.lateResult?.assertLateRejected();
      } catch (error) {
        completed.resolve();
        throw error;
      }
      const placement = expectDefined(native.placements.get(sessionId), "current native placement");
      expect(placement).toMatchObject({
        state: "active",
        executionMode: "remote-exec",
        turnClaim: { runId: params.runId },
      });
      const assertNativeCurrent = expectDefined(
        scope.assertNodeExecutionCurrent,
        "native effect guard",
      );
      const request = {
        runId: params.runId,
        agentId: target.agentId,
        nodeId: native.environment.nodeDeviceId!,
        workspace: {
          workspaceDir: native.remoteWorkspaceDir,
          environmentId: native.environment.environmentId,
          ownerEpoch: native.environment.ownerEpoch,
          sessionId,
          sessionKey: target.sessionKey,
        },
      };
      const assertCurrent = () => {
        authority.assertCurrent();
        assertNativeCurrent(request);
      };
      retainedGuard = assertCurrent;
      assertCurrent();
      expect(() => assertNativeCurrent({ ...request, nodeId: "retired-node" })).toThrow();
      expect(() =>
        assertNativeCurrent({
          ...request,
          workspace: { ...request.workspace, ownerEpoch: request.workspace.ownerEpoch - 1 },
        }),
      ).toThrow();
      if (originalGoal) {
        const history = await readIssuerFixtureHistory(target, sessionId);
        expect(history).toEqual(expect.arrayContaining(originalHistory));
        expect(
          history.filter(
            (message) => isRecord(message) && message.idempotencyKey === "original-goal",
          ),
        ).toEqual([
          expect.objectContaining({ role: "user", content: "Accepted original Goal work" }),
        ]);
      } else {
        await assertRecoveredOriginalInput(target, sessionId, originalRunId);
      }
      assertCurrent();
      const tunnel = await expectDefined(
        vi.mocked(native.environments.startTunnel).mock.results.at(-1)?.value,
        "current admitted native transport",
      );
      assertCurrent();
      const result = nativeEffect
        ? await nativeEffect({
            ...request,
            assertCurrent,
            acquireManagedWorkspaceAsync: native.acquireManagedWorkspaceAsync,
            runWorkspaceCommand: tunnel.runWorkspaceCommand.bind(tunnel),
          })
        : await tunnel.runWorkspaceCommand({
            argv: [
              "node",
              "-e",
              "process.stdout.write(require('node:fs').readFileSync('accepted.txt', 'utf8'))",
            ],
            timeoutMs: 10_000,
            assertCurrent,
          });
      assertCurrent();
      expect(result).toMatchObject({ code: 0, stdout: "accepted marker" });
      if (source !== "reclaimed") {
        expect(native.remoteWorkspaceDir).not.toBe(native.oldWorkspaceDir);
        await expect(
          fs.stat(path.join(native.remoteWorkspaceDir, "uncertain.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(path.join(native.oldWorkspaceDir, "uncertain.txt"), "utf8")).toBe(
          "unaccepted old worker edit",
        );
        const retention = (await loadTranscriptEvents({ ...target, sessionId })).filter(
          (event) =>
            isRecord(event) &&
            event.type === "custom_message" &&
            event.customType === "cloud-worker-retained",
        );
        expect(retention).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              display: true,
              content: expect.stringContaining(
                "refs/openclaw/worker-results/accepted-before-restart",
              ),
            }),
          ]),
        );
      }
      effects += 1;
      await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
      completed.resolve();
      return makeAttemptResult({
        terminal: { kind: "ok" },
        sessionIdUsed: sessionId,
        agentHarnessId: "codex",
        assistantTexts: ["Startup native continuation completed"],
        lastAssistant: makeAgentAssistantMessage({
          content: [{ type: "text", text: "Startup native continuation completed" }],
          timestamp: Date.now(),
        }),
      });
    });
    let nextRuntime: ReturnType<typeof createGatewayInstanceRuntime> | undefined;
    let startup: ReturnType<typeof scheduleRestartAbortedMainSessionRecovery> | undefined;
    const startupCheckedStorePaths = new Set<string>();
    try {
      stage = "original-admission";
      if (intent === "goal") {
        ({ goal: originalGoal, history: originalHistory } = await prepareOriginalStartupGoal({
          fixture,
          target,
          sessionId,
          workspaceDir: state.workspaceDir,
          originalIssuer,
        }));
      } else {
        await acceptOriginalIssuerTurn(
          fixture,
          target,
          sessionId,
          originalRunId,
          native.repository.workspaceId,
          700100,
        );
        stage = "original-attempt-entry";
        await Promise.race([
          entered.promise,
          fixture.work.runWhenIdle(() => {
            expect(
              originalAttemptEntered,
              JSON.stringify({ lastError: loadSessionEntry(target)?.lastRunError }),
            ).toBe(true);
          }),
        ]);
      }
      await native.lateResult?.beginOriginal(fixture.original!.authority);
      stage = "restart-marker";
      const marked = await markRestartAbortedMainSessions({
        cfg: fixture.cfg,
        resolveGatewayContext: () => fixture.context,
        captureGoals: intent === "goal" ? true : undefined,
        activeRuns:
          intent === "goal"
            ? []
            : [
                {
                  ...target,
                  sessionId,
                  runId: originalRunId,
                  lifecycleGeneration: getAgentEventLifecycleGeneration(),
                  accepted: true,
                },
              ],
        isActiveRun: () => true,
        reason: "synthetic startup interruption",
      });
      expect(marked.marked).toBe(1);
      if (intent === "turn") {
        interruptOriginalNoGoalTurn(fixture, target, originalRunId);
      } else {
        expect(loadSessionEntry(target)?.restartRecoveryGoal?.id).toBe(originalGoal?.id);
      }
      interrupt.resolve();
      await fixture.work.runWhenIdle(() => {});
      await native.settlePrevious();
      fixture.original!.release();
      fixture.deviceSource.release();
      fixture.runtime.close();
      rotateAgentEventLifecycleGeneration();
      await closeOpenClawAgentDatabasesAsync();
      if (source === "failed-cleanup") {
        proofsBeforeAutomaticDisposal = native.repositoryProof.proofs.size;
        const failedRecovery = expectDefined(native.failedRecovery, "original failed checkpoint");
        const before = native.placements.get(sessionId);
        const checkpoint = expectDefined(
          await getSessionRepositoryWorkspaceStore().get(native.repository.workspaceId),
          "original accepted disposal checkpoint",
        );
        const reconcile = expectDefined(
          native.reconcileFailedPlacement,
          "existing automatic cleanup owner",
        );
        await reconcile(failedRecovery.originalEnvironmentId);
        expect(native.environments.get(failedRecovery.originalEnvironmentId)).toMatchObject({
          state: "destroyed",
          recoveryHold: {
            phase: "disposal-pending",
            diagnostic: { origin: "failed-placement", cause: "unverified" },
            disposalCheckpoint: {
              checkpointRef: checkpoint?.checkpointRef,
              previousCheckpointRef: checkpoint?.checkpointRef,
              manifestHash: checkpoint?.manifestHash,
            },
            cleanup: { settledAtMs: expect.any(Number), providerReleasedAtMs: expect.any(Number) },
          },
        });
        expect(native.placements.get(sessionId)).toEqual(before);
        expect(
          await getSessionRepositoryWorkspaceStore().get(native.repository.workspaceId),
        ).toEqual(checkpoint);
        expect(native.redispatches()).toBe(0);
        expect(native.coldAllocations()).toBe(0);
        expect(native.repositoryProof.proofs.size).toBe(proofsBeforeAutomaticDisposal);
        await reconcile(failedRecovery.originalEnvironmentId);
        expect(failedRecovery.destroy).toHaveBeenCalledOnce();
      }
      if (originalGoal) {
        expect(loadSessionEntry(target)?.goal).toEqual(originalGoal);
        const history = await readIssuerFixtureHistory(target, sessionId);
        expect(history.slice(0, originalHistory.length)).toEqual(originalHistory);
        expect(history.slice(originalHistory.length)).toEqual(
          source === "failed-cleanup"
            ? [expect.objectContaining({ customType: "cloud-worker-retained" })]
            : [],
        );
      }
      const context = createGatewayRequestContext(
        makeContextParams({
          connectionWork: { track: (run) => fixture.work.track(run) },
          sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
            current: "original-shared",
            required: null,
          }),
        }),
      );
      context.getRuntimeConfig = () => fixture.cfg;
      context.getCommittedRuntimeConfig = () => fixture.cfg;
      context.resolveGatewayContext = () => context;
      context.getGatewayMethodRegistry = () => fixture.methods;
      nextRuntime = createGatewayInstanceRuntime({
        getContext: () => context,
        getMethodRegistry: () => fixture.methods,
        isDispatchAvailable: () => true,
      });
      if (mode === "revoked") {
        const dispatch = nextRuntime.recovery.dispatchAgent;
        nextRuntime.recovery.dispatchAgent = <T>(
          request: AgentRunRequest,
          timeoutMs?: number,
          options: GatewayInstanceAgentDispatchOptions = {},
        ): Promise<T> =>
          dispatch<T>(request, timeoutMs, {
            ...options,
            onExecutionStarted: async () => {
              await options.onExecutionStarted?.();
              await setCanonicalUserProfileRole(fixture.profile.id, "revoked");
            },
          });
      }
      context.recoveryRuntime = nextRuntime.recovery;
      context.createAgentTurnFacade = nextRuntime.createAgentTurnFacade;
      fixture.context = context;
      startup = scheduleRestartAbortedMainSessionRecovery({
        getConfig: () => fixture.cfg,
        stateDir: state.stateDir,
        delayMs: 0,
        maxRetries: 1,
        startupCheckedStorePaths,
        gatewayRuntime: nextRuntime.recovery,
      });
      stage = "startup-effect";
      await completed.promise;
      stage = "startup-settlement";
      await fixture.work.runWhenIdle(() => {});
      expect(
        effects,
        JSON.stringify({
          warnings: warnings.mock.calls.map(([message]) => message),
          lastError: loadSessionEntry(target)?.lastRunError,
          nativeCalls: nativeAttempt.mock.calls.length,
          harnessCalls: native.harnessAttempts.mock.calls.length,
          attemptError,
          redispatches: native.redispatches(),
          coldAllocations: native.coldAllocations(),
          credentialErrors: native.credentialErrors(),
          repositoryRequests: native.repositoryProof.fetchFixture.mock.calls.map(([input]) => {
            const url = new URL(input instanceof Request ? input.url : input);
            return { origin: url.origin, pathname: url.pathname };
          }),
        }),
      ).toBe(expectedEffects);
      await native.lateResult?.assertLateRejected();
      const allocated =
        mode === "revoked-after-disposal" ||
        preparedScenario === "unknown-claim" ||
        preparedScenario === "target-replaced"
          ? 0
          : 1;
      expect(native.redispatches()).toBe(allocated);
      expect(native.coldAllocations()).toBe(preparedScenario === "warm" ? 0 : allocated);
      if (preparedScenario === "warm") {
        expect(native.environment.environmentId).toBe(native.warmEnvironment()?.environmentId);
        expect(native.warmEnvironment()?.preparation?.consumedAtMs).not.toBeNull();
      }
      if (preparedScenario === "miss") {
        expect(native.environment.environmentId).not.toBe(native.warmEnvironment()?.environmentId);
        expect(native.warmEnvironment()?.preparation?.consumedAtMs).toBeNull();
      }
      if (preparedScenario === "unknown-claim") {
        const retained = expectDefined(await native.readWarmClaim(), "committed claim readback");
        expect(retained.preparation?.consumedAtMs).not.toBeNull();
        expect(retained).toMatchObject(
          expectDefined(native.warmReceipt(), "original reserve receipt"),
        );
        expect(retained.state).not.toBe("destroyed");
        expect(native.placements.get(sessionId)).toMatchObject({
          state: "failed",
          environmentId: retained.environmentId,
        });
      }
      if (allocated) {
        expect(native.environment.nodeDeviceId).toBe("fresh-recovery-node");
      }
      if (preparedScenario === "target-replaced") {
        expect(native.credentialErrors()).toContain(
          "Factory repository redispatch workspace changed",
        );
        expect(nativeAttempt).not.toHaveBeenCalled();
      }
      if (source === "failed-cleanup" && mode === "revoked-after-disposal") {
        expect(native.repositoryProof.proofs.size).toBe(proofsBeforeAutomaticDisposal);
      } else {
        expect(native.repositoryProof.proofs.size).toBeGreaterThan(0);
      }
      if (native.failedRecovery) {
        expect(native.failedRecovery.events).toEqual(["hold", "destroy", "retire"]);
        expect(native.failedRecovery.destroy).toHaveBeenCalledOnce();
        expect(native.failedRecovery.holdFailedLease).toHaveBeenCalledOnce();
        expect(native.failedRecovery.destroySnapshots).toEqual([
          expect.objectContaining({
            placement: expect.objectContaining({ state: "failed", turnClaim: null }),
            repository: expect.objectContaining({
              checkpointRef: native.failedRecovery.acceptedCheckpointRef,
            }),
            environment: expect.objectContaining({
              state: "destroying",
              recoveryHold: expect.objectContaining({
                phase: "disposal-pending",
                diagnostic: expect.objectContaining({ cause: "unverified" }),
                disposalCheckpoint: expect.objectContaining({
                  previousCheckpointRef: native.failedRecovery.acceptedCheckpointRef,
                }),
                receipt: expect.objectContaining({
                  resources: expect.arrayContaining([
                    expect.objectContaining({
                      kind: "vm",
                      immutableId: "original-vm",
                      state: "retained",
                    }),
                    expect.objectContaining({
                      kind: "disk",
                      immutableId: "original-disk",
                      state: "retained",
                    }),
                    expect.objectContaining({
                      kind: "nic",
                      immutableId: "original-nic",
                      state: "retained",
                    }),
                    expect.objectContaining({
                      kind: "public-ip",
                      immutableId: "original-ip",
                      state: "retained",
                    }),
                  ]),
                }),
              }),
            }),
          }),
        ]);
        expect(native.environments.get(native.failedRecovery.originalEnvironmentId)).toMatchObject({
          state: "destroyed",
          recoveryHold: { cleanup: { settledAtMs: expect.any(Number) } },
        });
        if (mode === "revoked-after-disposal") {
          expect(native.placements.get(sessionId)?.state).toBe("failed");
        }
      }
      if (expectedEffects) {
        expect(retainedGuard).toThrow();
      } else if (mode === "revoked-after-read") {
        expect(nativeAttempt).toHaveBeenCalledOnce();
        expect(attemptError).toBe(
          "Gateway access is not active for this account; ask a Gateway administrator to grant or restore access.",
        );
      } else {
        expect(nativeAttempt).not.toHaveBeenCalled();
      }
      expect(startupCheckedStorePaths.size).toBeGreaterThan(0);
      // Post-attach and scheduler retries share one physical startup scan owner.
      const repeatedMark = await markStartupOrphanedMainSessionsForRecovery({
        cfg: fixture.cfg,
        stateDir: state.stateDir,
        startupCheckedStorePaths,
      });
      expect(repeatedMark.marked).toBe(0);
      await recoverRestartAbortedMainSessions({
        cfg: fixture.cfg,
        stateDir: state.stateDir,
        gatewayRuntime: nextRuntime.recovery,
      });
      await fixture.work.runWhenIdle(() => {});
      expect(effects).toBe(expectedEffects);
      expect(loadSessionEntry(target)?.sessionId).toBe(sessionId);
      if (originalGoal) {
        expect(loadSessionEntry(target)?.goal).toMatchObject({
          id: originalGoal.id,
          tokenStart: 100,
          tokensUsed: 80,
          tokenBudget: 500,
          continuationTurns: 3,
        });
        expect(await readIssuerFixtureHistory(target, sessionId)).toEqual(
          expect.arrayContaining(originalHistory),
        );
      }
    } finally {
      native.lateResult?.release();
      interrupt.resolve();
      try {
        await startup?.stop();
        nextRuntime?.close();
        fixture.runtime.close();
        await fixture.work.drain();
        await native.close();
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        nativeAttempt.mockReset();
      }
    }
  });
}
