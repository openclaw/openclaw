import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { seedCanonicalAcpSessionMeta } from "../../acp/runtime/session-meta-fixture.test-support.js";
import * as acpReads from "../../acp/runtime/session-meta-readonly.js";
import type { EmbeddedAgentQueueHandle } from "../../agents/embedded-agent-runner/run-state.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
  resolveActiveEmbeddedRunOwnerByRunId,
} from "../../agents/embedded-agent-runner/runs.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import {
  areDiagnosticsEnabledForProcess,
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { getDiagnosticSessionState } from "../../logging/diagnostic-session-state.js";
import {
  startGatewayDiagnosticHeartbeat,
  stopGatewayDiagnosticHeartbeat,
} from "../../logging/diagnostic.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import { runSessionMutation } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { listActiveSessionRunKeys } from "../../sessions/session-controller.queries.js";
import {
  requestRpcSourceCancellation,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { withPluginSubagentTestState } from "./agent.spawned-child.test-support.js";
import {
  backendGatewayClient,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  prime,
  waitForAssertion,
} from "./agent.test-harness.js";
import { getAgentTestStorePath } from "./agent.user-turn-recorder.test-support.js";

const mocks = getAgentTestMocks();

function mockCompletedRun(sessionKey: string): void {
  const run = createSubagentRunRecord({
    runId: "previous-run",
    childSessionKey: sessionKey,
    execution: { status: "terminal", endedAt: 3 },
  });
  mocks.getLatestSubagentRunByChildSessionKey.mockReturnValueOnce(run);
  mocks.getLatestLiveSubagentRunByChildSessionKey.mockReturnValue(run);
}

function expectReactivationFailure(respond: ReturnType<typeof vi.fn>, runId: string): void {
  expect(mocks.replaceSubagentRunAfterSteer).toHaveBeenCalledOnce();
  expect(respond).toHaveBeenCalledWith(
    false,
    { runId, status: "error", summary: "reactivate boom" },
    { code: "UNAVAILABLE", message: "reactivate boom" },
    { runId, error: "reactivate boom" },
  );
}

export function setupRestartRecoveryAdmissionFixture(runId: string) {
  const sessionKey = "agent:main:main";
  const sessionId = "recovery-session";
  const storePath = getAgentTestStorePath();
  const store: Record<string, SessionEntry> = {
    [sessionKey]: {
      sessionId,
      updatedAt: Date.now() - 10_000,
      status: "interrupted",
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: runId,
      restartRecoveryDeliverySourceRunId: "interrupted-source-run",
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 1,
        reservation: { runId, attempt: 1, lifecycleGeneration: mocks.lifecycleGeneration },
      },
    },
  };
  mocks.loadSessionEntry.mockImplementation(() => ({
    cfg: {},
    agentId: "main",
    storePath,
    entry: structuredClone(store[sessionKey]),
    canonicalKey: sessionKey,
  }));
  mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
  return { sessionKey, sessionId, storePath, store };
}

export function registerAgentPreDispatchFailureTests() {
  it("retires stale processing when an admitted replacement fails before native startup", async () => {
    const diagnosticsEnabled = areDiagnosticsEnabledForProcess();
    setDiagnosticsEnabledForProcess(true);
    try {
      await withPluginSubagentTestState("openclaw-pre-native-idle-", async () => {
        const sessionKey = "agent:main:main";
        const sessionId = "pre-native-idle-session";
        const runId = "pre-native-idle-next";
        const priorRunId = "pre-native-idle-prior";
        prime(sessionId);
        const prior = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
        const handle: EmbeddedAgentQueueHandle = {
          kind: "embedded",
          runId: priorRunId,
          queueMessage: async () => {},
          isStreaming: () => false,
          isAbortable: () => false,
          isCompacting: () => false,
          abort: () => {},
        };
        const attachment = attachActiveEmbeddedRun(
          sessionId,
          handle,
          sessionKey,
          undefined,
          undefined,
          prior,
        );
        const clock = createGatewaySchedulerClock(Date.now());
        const scheduler = createTestGatewayScheduler(clock.clock);
        let stuckCount = 0;
        const unsubscribe = onDiagnosticEvent((event) => {
          if (event.type === "session.stuck" && event.sessionKey === sessionKey) {
            stuckCount += 1;
          }
        });
        try {
          expect(getDiagnosticSessionState({ sessionKey, sessionId })).toMatchObject({
            state: "processing",
            queueDepth: 0,
          });
          expect(resolveActiveEmbeddedRunOwnerByRunId(priorRunId)).toBeDefined();
          prior.complete();
          mocks.agentCommand.mockImplementationOnce(() => {
            // Command startup follows withSessionTurn; its exact replacement owns admission.
            const operation = rpcSourceTesting.get(runId)?.input.claim?.operation;
            expect(operation).toBeDefined();
            expect(operation).not.toBe(prior);
            expect(listActiveSessionRunKeys()).toContain(sessionKey);
            detachActiveEmbeddedRun(
              sessionId,
              handle,
              sessionKey,
              undefined,
              "run_completed",
              attachment,
            );
            throw new Error("pre-native command failed");
          });
          const respond = vi.fn();
          await invokeAgent(
            { message: "continue", agentId: "main", sessionKey, idempotencyKey: runId },
            { context: makeContext(), reqId: runId, respond },
          );
          await waitForAssertion(() => {
            expect(respond).toHaveBeenCalledWith(
              false,
              expect.objectContaining({
                runId,
                status: "error",
                summary: "pre-native command failed",
              }),
              expect.objectContaining({
                code: "UNAVAILABLE",
                message: "pre-native command failed",
              }),
              expect.anything(),
            );
            expect(listActiveSessionRunKeys()).not.toContain(sessionKey);
          });
          expect(mocks.agentCommand).toHaveBeenCalledOnce();
          expect(resolveActiveEmbeddedRunOwnerByRunId(priorRunId)).toBeUndefined();
          // Direct Gateway admission has no channel message counter to clean up.
          expect(getDiagnosticSessionState({ sessionKey, sessionId })).toMatchObject({
            state: "idle",
            queueDepth: 0,
          });
          startGatewayDiagnosticHeartbeat(
            scheduler,
            { diagnostics: { enabled: true } },
            {
              sampleLiveness: () => null,
              startupGraceMs: 0,
              testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
            },
          );
          await clock.advanceBy(30_000);
          await clock.advanceBy(30_000);
          await waitForDiagnosticEventsDrained();
          expect(stuckCount).toBe(0);
        } finally {
          unsubscribe();
          stopGatewayDiagnosticHeartbeat();
          await scheduler.stop();
          detachActiveEmbeddedRun(
            sessionId,
            handle,
            sessionKey,
            undefined,
            "run_completed",
            attachment,
          );
          prior.complete();
          resetDiagnosticStateForTest();
        }
      });
    } finally {
      setDiagnosticsEnabledForProcess(diagnosticsEnabled);
    }
  });

  it.each([{ acp: false }, { acp: true }, { acp: true, cancel: true }])(
    "keeps pre-dispatch reactivation with its runtime (%j)",
    async ({ acp, cancel }) => {
      await withPluginSubagentTestState("openclaw-reactivation-owner-", async () => {
        prime("reactivation-session");
        if (acp) {
          seedCanonicalAcpSessionMeta({
            sessionKey: "agent:main:main",
            sessionId: "reactivation-session",
            meta: {
              backend: "acpx",
              agent: "main",
              runtimeSessionName: "reactivation-owner",
              mode: "persistent",
              state: "idle",
              lastActivityAt: 1,
            },
          });
          mocks.agentCommand.mockResolvedValue({ payloads: [], meta: { durationMs: 1 } });
        }
        mockCompletedRun("agent:main:main");
        mocks.replaceSubagentRunAfterSteer.mockImplementationOnce(() => {
          throw new Error("reactivate boom");
        });

        const context = makeContext();
        const runId = "idem-abort-reactivation-fails";
        const terminal = createDeferred();
        const cancellationError = new Error("ACP preparation cancelled");
        let source: RpcSourceRef | undefined;
        const respond = vi.fn((_ok, payload, error) => {
          if (
            error ||
            payload?.status === "ok" ||
            payload?.status === "error" ||
            payload?.status === "timeout"
          ) {
            terminal.resolve();
          }
        });
        const read = acpReads.readAcpSessionMetaForEntries;
        const cancellation = cancel
          ? vi
              .spyOn(acpReads, "readAcpSessionMetaForEntries")
              .mockImplementationOnce(async (...args) => {
                const result = await read(...args);
                const active = rpcSourceTesting.get(runId);
                if (!active) {
                  throw new Error("Expected the ACP read to retain run admission");
                }
                source = active;
                expect(requestRpcSourceCancellation(active, cancellationError)).toBe(true);
                return result;
              })
          : undefined;
        try {
          await invokeAgent(
            {
              message: "hi",
              agentId: "main",
              sessionKey: "agent:main:main",
              idempotencyKey: runId,
            },
            { context, reqId: runId, respond },
          );
          source ??= rpcSourceTesting.get(runId);
          await terminal.promise;
          await source?.input.settlement.promise;

          expect(rpcSourceTesting.has(runId)).toBe(false);
          if (cancel) {
            expect(mocks.replaceSubagentRunAfterSteer).not.toHaveBeenCalled();
            expect(mocks.agentCommand).not.toHaveBeenCalled();
            expect(source?.input.abortSignal.reason).toBe(cancellationError);
            expect(respond).toHaveBeenCalledWith(
              true,
              expect.objectContaining({
                runId,
                status: "timeout",
                summary: "aborted",
                stopReason: "aborted",
                timeoutPhase: "queue",
                providerStarted: false,
              }),
              undefined,
              { runId },
            );
          } else if (acp) {
            expect(mocks.replaceSubagentRunAfterSteer).not.toHaveBeenCalled();
            expect(mocks.agentCommand).toHaveBeenCalledOnce();
            expect(respond).toHaveBeenCalledWith(
              true,
              expect.objectContaining({ runId, status: "ok" }),
              undefined,
              expect.anything(),
            );
          } else {
            expect(mocks.agentCommand).not.toHaveBeenCalled();
            expectReactivationFailure(respond, runId);
          }
        } finally {
          cancellation?.mockRestore();
          await source?.input.settlement.promise;
        }
      });
    },
  );

  it.each(["pending input admission", "pre-dispatch reactivation"] as const)(
    "restores admitted restart recovery if %s fails",
    async (failurePhase) => {
      const runId = "recovery-reactivation-fails";
      const { sessionKey, sessionId, store } = setupRestartRecoveryAdmissionFixture(runId);
      const inputError = new Error("Pending input ownership ended; submit a new turn to continue");
      if (failurePhase === "pending input admission") {
        mocks.stageSessionPendingInput.mockImplementationOnce(async () => {
          expect(store[sessionKey]?.abortedLastRun).toBe(false);
          expect(store[sessionKey]?.mainRestartRecovery?.reservation).toBeUndefined();
          throw inputError;
        });
      } else {
        mockCompletedRun(sessionKey);
        mocks.replaceSubagentRunAfterSteer.mockImplementationOnce(() => {
          throw new Error("reactivate boom");
        });
      }

      const context = makeContext();
      const respond = vi.fn();
      await invokeAgent(
        {
          message: "resume after restart",
          agentId: "main",
          sessionKey,
          sessionId,
          expectedExistingSessionId: sessionId,
          idempotencyKey: runId,
          inputProvenance: {
            kind: "internal_system",
            sourceSessionKey: sessionKey,
            sourceTool: "main_session_restart_recovery",
          },
        },
        { context, client: backendGatewayClient(), reqId: runId, respond },
      );

      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(store[sessionKey]).toMatchObject({
        sessionId,
        status: "interrupted",
        abortedLastRun: true,
        restartRecoveryDeliverySourceRunId: "interrupted-source-run",
        mainRestartRecovery: {
          chargedAttempts: 1,
        },
      });
      expect(rpcSourceTesting.has(runId)).toBe(false);
      expect(store[sessionKey]?.mainRestartRecovery?.reservation).toBeUndefined();
      expect(store[sessionKey]?.restartRecoveryDeliveryRunId).toBeUndefined();
      if (failurePhase === "pending input admission") {
        expect(respond.mock.calls).toEqual([
          [false, undefined, { code: "UNAVAILABLE", message: inputError.message }],
        ]);
      } else {
        expectReactivationFailure(respond, runId);
      }
    },
  );

  it("releases a foreground recovery owner if pre-dispatch reactivation fails", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "interrupted-session";
    const runId = "foreground-reactivation-fails";
    const storePath = getAgentTestStorePath();
    const store: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 10_000,
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 1,
          chargedAttempts: 1,
        },
      },
    };
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath,
      entry: structuredClone(store[sessionKey]),
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mockCompletedRun(sessionKey);
    mocks.replaceSubagentRunAfterSteer.mockImplementationOnce(() => {
      throw new Error("reactivate boom");
    });

    const respond = await invokeAgent(
      {
        message: "new foreground turn",
        agentId: "main",
        sessionKey,
        sessionId,
        idempotencyKey: runId,
      },
      { client: backendGatewayClient(), reqId: runId },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(store[sessionKey]?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
    expectReactivationFailure(respond, runId);
  });

  it("releases gateway admission when foreground owner cleanup exhausts retries", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "interrupted-session";
    const runId = "foreground-release-fails";
    const storePath = getAgentTestStorePath();
    const store: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 10_000,
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 1,
          chargedAttempts: 1,
        },
      },
    };
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath,
      entry: structuredClone(store[sessionKey]),
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.applySessionEntryReplacements.mockRejectedValue(new Error("owner release write failed"));

    await expect(
      invokeAgent(
        {
          message: "new foreground turn",
          agentId: "main",
          sessionKey,
          sessionId,
          deliver: true,
          replyChannel: "telegram",
          bestEffortDeliver: false,
          idempotencyKey: runId,
        },
        {
          client: backendGatewayClient(),
          reqId: runId,
          respond: vi.fn(),
          flushDispatch: false,
        },
      ),
    ).rejects.toThrow("owner release write failed");
    await expect(
      runSessionMutation({
        scope: storePath,
        identities: [sessionKey, sessionId],
        signal: AbortSignal.timeout(100),
        run: async () => "released",
      }),
    ).resolves.toBe("released");
  });
}
