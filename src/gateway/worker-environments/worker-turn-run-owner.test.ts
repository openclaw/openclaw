import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  isEmbeddedAgentRunHandleActive,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunOwner,
} from "../../agents/embedded-agent-runner/runs.js";
import { resolveSessionPlacementTurnSettlementAssertion } from "../../agents/session-placement-forced-terminal-settlement.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { ReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { isReplyRunEvidenceStale } from "../../auto-reply/reply/reply-run-registry.state.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { getDiagnosticSessionActivitySnapshot } from "../../logging/diagnostic-run-activity.js";
import { recoverStuckDiagnosticSession } from "../../logging/diagnostic-stuck-session-recovery.runtime.js";
import {
  logSessionStateChange,
  startGatewayDiagnosticHeartbeat,
  stopGatewayDiagnosticHeartbeat,
} from "../../logging/diagnostic.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { createWorkerLiveEventReceiver } from "./live-events.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { getWorkerTurnExecutionIdentityCapability } from "./placement-turn-claim-events.js";
import {
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  measureLaunchTurn,
  readLaunchToolNames,
  placements,
  seedActivePlacement,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";

afterAll(closeStateDatabaseForTest);

describe("cloud worker run ownership", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));

  it.each([
    { cancellation: "user", firstToolDelayMs: 0 },
    { cancellation: "deadline", firstToolDelayMs: 10 * 60_000 },
  ] as const)(
    "keeps a bounded remote tool alive until $cancellation cancellation after a $firstToolDelayMs ms tool-start delay",
    async ({ cancellation, firstToolDelayMs }) => {
      const turnStartedAtMs = Date.UTC(2026, 7, 29);
      vi.useFakeTimers({ toFake: ["Date"], now: turnStartedAtMs });
      await seedActivePlacement();
      const launched = createDeferred();
      const finishLaunch = createDeferred();
      let workerSignal: AbortSignal | undefined;
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: () => attachedEnvironment(),
        acquireTurnCredential: async () => credential(),
        acknowledgeCredentialDelivery: async () => true,
        startTunnel: async () => ({
          environmentId: ENVIRONMENT_ID,
          ownerEpoch: OWNER_EPOCH,
          runWorkspaceCommand: vi.fn(),
          quiesceWorkspace: vi.fn(),
          syncWorkspace: vi.fn(),
          reconcileWorkspace: vi.fn(),
          stop: vi.fn(),
          measureLaunchTurn,
          readLaunchToolNames,
          launchTurn: async (request) => {
            request.onDispatchReady?.();
            workerSignal = request.signal;
            launched.resolve();
            await Promise.race([
              finishLaunch.promise,
              new Promise<void>((resolve) => {
                request.signal?.addEventListener("abort", () => resolve(), { once: true });
              }),
            ]);
            throw new Error("worker turn cancelled");
          },
        }),
        stopTunnel: vi.fn(),
        destroy: vi.fn(async () => attachedEnvironment()),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      const operation = createReplyOperation({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        resetTriggered: false,
      });
      operation.setPhase("running");
      const runId = "run-bounded-worker-tool";
      registerAgentRunContext(runId, {
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
      });
      const input = {
        ...turn(runId),
        timeoutMs: 30 * 60_000,
        replyOperation: operation,
        abortSignal: operation.abortSignal,
      };
      const attempt = provider
        .executeTurn(
          { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
          input,
          vi.fn(),
        )
        .catch((error: unknown) => error);
      await launched.promise;
      const active = placements.get(SESSION_ID);
      if (!active) {
        throw new Error("expected active placement");
      }
      const turnClaim = projectWorkerSessionTurnClaim(active);
      if (!turnClaim) {
        throw new Error("expected admitted worker turn");
      }
      const turnCapability = getWorkerTurnExecutionIdentityCapability(placements, turnClaim);
      if (!turnCapability) {
        throw new Error("expected worker turn capability");
      }
      const identity: WorkerConnectionIdentity = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        sessionId: SESSION_ID,
        runId,
        turnClaim,
        credentialHash: "worker-test-credential-hash",
        bundleHash: "a".repeat(64),
        rpcSetVersion: 1,
        protocolFeatures: ["worker-live-event-v1"],
        credentialExpiresAtMs: Date.now() + input.timeoutMs,
      };
      const receiver = createWorkerLiveEventReceiver();
      vi.useFakeTimers({
        toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
        now: turnStartedAtMs + firstToolDelayMs,
      });
      const previousDiagnostics = areDiagnosticsEnabledForProcess();
      setDiagnosticsEnabledForProcess(true);
      logSessionStateChange({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        state: "processing",
      });
      startGatewayDiagnosticHeartbeat(
        createTestGatewayScheduler("fake-timers"),
        { diagnostics: { enabled: true } },
        {
          recoverStuckSession: recoverStuckDiagnosticSession,
          sampleLiveness: () => null,
        },
      );
      try {
        expect(
          await receiver.apply({
            readAckedSeq: () => 0,
            source: turnCapability,
            identity,
            request: {
              runEpoch: OWNER_EPOCH,
              lastAckedSeq: 0,
              seq: 1,
              runId,
              event: {
                kind: "tool",
                payload: {
                  phase: "start",
                  name: "sessions_spawn",
                  toolCallId: "child-provision",
                  args: {},
                },
              },
            },
          }),
        ).toEqual({ ok: true, result: { ackedSeq: 1 } });
        await vi.advanceTimersByTimeAsync(20 * 60_000 + 1 - firstToolDelayMs);

        expect(operation.abortSignal.aborted).toBe(false);
        expect(isReplyRunEvidenceStale(operation)).toBe(false);
        expect(workerSignal?.aborted).toBe(false);
        expect(placements.validateTurnClaim(turnClaim)).toBe(true);
        expect(getDiagnosticSessionActivitySnapshot({ sessionId: SESSION_ID })).toMatchObject({
          activeWorkKind: "tool_call",
          activeToolName: "sessions_spawn",
          hasActiveEmbeddedRun: true,
        });
        await expect(
          queueEmbeddedAgentMessageWithOutcomeAsync(SESSION_ID, "follow up"),
        ).resolves.toMatchObject({ queued: false, reason: "not_streaming" });
        if (cancellation === "user") {
          expect(resolveActiveEmbeddedRunOwner(SESSION_ID)?.abort()).toBe(true);
          expect(placements.validateTurnClaim(turnClaim)).toBe(true);
          await expect(turnCapability.run(async () => "late effect")).rejects.toThrow();
        } else {
          expect(
            await receiver.apply({
              readAckedSeq: () => 0,
              source: turnCapability,
              identity,
              request: {
                runEpoch: OWNER_EPOCH,
                lastAckedSeq: 1,
                seq: 2,
                runId,
                event: {
                  kind: "tool",
                  payload: {
                    phase: "update",
                    name: "sessions_spawn",
                    toolCallId: "child-provision",
                    partialResult: {},
                  },
                },
              },
            }),
          ).toEqual({ ok: true, result: { ackedSeq: 2 } });
          vi.setSystemTime(turnStartedAtMs + input.timeoutMs);
          expect(isReplyRunEvidenceStale(operation)).toBe(false);
          vi.setSystemTime(turnStartedAtMs + input.timeoutMs + 1);
          expect(isReplyRunEvidenceStale(operation)).toBe(true);
          await vi.advanceTimersByTimeAsync(60_000);
          expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
        }
        expect(workerSignal?.aborted).toBe(true);
        await attempt;
        expect(isEmbeddedAgentRunHandleActive(SESSION_ID)).toBe(false);
        expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
        expect(
          getDiagnosticSessionActivitySnapshot({ sessionId: SESSION_ID }).activeWorkKind,
        ).toBeUndefined();
        expect(environments.destroy).not.toHaveBeenCalled();
      } finally {
        stopGatewayDiagnosticHeartbeat();
        setDiagnosticsEnabledForProcess(previousDiagnostics);
        finishLaunch.resolve();
        operation.abortByUser();
        await attempt;
        operation.complete();
        receiver.clear();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { closure: "replacement", cancelled: false },
    { closure: "claim-loss", cancelled: false },
    { closure: "shutdown", cancelled: false },
    { closure: "replacement", cancelled: true },
    { closure: "claim-loss", cancelled: true },
    { closure: "shutdown", cancelled: true },
    { closure: "same-claim replacement", cancelled: true },
    { closure: "same-claim readmission", cancelled: true },
  ] as const)(
    "fences retained event recorders after $closure, cancelled: $cancelled",
    async ({ closure, cancelled }) => {
      const { captureWorkerTurnLiveEventOwner, createWorkerTurnRunOwner } =
        await import("./worker-turn-run-owner.js");
      await seedActivePlacement();
      const runId = "reused-worker-run";
      const claimInput = {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId,
        owner: { kind: "worker" as const, environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
      };
      const firstClaim = await placements.claimTurn({ ...claimInput, claimId: "first-claim" });
      let assertSettlementCurrent: (() => void) | undefined;
      const first = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: SESSION_KEY,
          embeddedRunToolAuthorityBinding: () => {
            assertSettlementCurrent = resolveSessionPlacementTurnSettlementAssertion();
            const project = (_overlay: ReplyToolAuthorityOverlay) => "worker-turn-authority";
            return {
              source: "reply",
              project,
              projectAsync: async (overlay) => project(overlay),
              assertActive: () => {},
            };
          },
        },
        () =>
          createWorkerTurnRunOwner({
            placements,
            claim: firstClaim,
            turn: turn(runId),
            sessionKey: SESSION_KEY,
          }),
      );
      expect(assertSettlementCurrent).toBeTypeOf("function");
      assertSettlementCurrent?.();
      const identity: WorkerConnectionIdentity = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        sessionId: SESSION_ID,
        runId,
        turnClaim: firstClaim,
        credentialHash: "test",
        bundleHash: "a".repeat(64),
        rpcSetVersion: 1,
        protocolFeatures: [],
        credentialExpiresAtMs: Date.now() + 60_000,
      };
      const eventOwner = captureWorkerTurnLiveEventOwner(identity);
      expect(eventOwner?.record).toBeTypeOf("function");
      if (cancelled) {
        expect(resolveActiveEmbeddedRunOwner(SESSION_ID)?.abort()).toBe(true);
        expect(eventOwner?.isCancelled()).toBe(true);
      }
      const event = {
        kind: "tool" as const,
        payload: {
          phase: "start" as const,
          name: "sessions_spawn",
          toolCallId: "stale-tool",
          args: {},
        },
      };
      let replacement: Awaited<ReturnType<typeof createWorkerTurnRunOwner>> | undefined;
      try {
        if (closure === "shutdown") {
          rotateAgentEventLifecycleGeneration();
          expect(resolveActiveEmbeddedRunOwner(SESSION_ID)).toBeUndefined();
          expect(first.signal.aborted).toBe(true);
        } else if (closure === "same-claim replacement") {
          replacement = await createWorkerTurnRunOwner({
            placements,
            claim: firstClaim,
            turn: turn(runId),
            sessionKey: SESSION_KEY,
          });
          expect(captureWorkerTurnLiveEventOwner(identity)).not.toBe(eventOwner);
        } else {
          await placements.releaseTurn(firstClaim);
          expect(() => assertSettlementCurrent?.()).toThrow("settlement is closed");
          if (closure === "same-claim readmission") {
            await placements.claimTurn({ ...claimInput, claimId: firstClaim.claimId });
          } else if (closure === "replacement") {
            const nextClaim = await placements.claimTurn({
              ...claimInput,
              claimId: "replacement-claim",
            });
            replacement = await createWorkerTurnRunOwner({
              placements,
              claim: nextClaim,
              turn: turn(runId),
              sessionKey: SESSION_KEY,
            });
            expect(captureWorkerTurnLiveEventOwner(identity)).toBeUndefined();
            const current = captureWorkerTurnLiveEventOwner({
              ...identity,
              turnClaim: nextClaim,
            });
            current?.record({
              ...event,
              payload: { ...event.payload, toolCallId: "current-tool", name: "exec" },
            });
          }
        }
        eventOwner?.record(event);
        expect(eventOwner?.isCancelled()).toBe(false);
        const activity = getDiagnosticSessionActivitySnapshot({ sessionId: SESSION_ID });
        expect(activity.activeToolCallId).toBe(
          closure === "replacement" ? "current-tool" : undefined,
        );
        first.dispose();
        expect(isEmbeddedAgentRunHandleActive(SESSION_ID)).toBe(
          closure === "replacement" || closure === "same-claim replacement",
        );
      } finally {
        first.dispose();
        replacement?.dispose();
      }
    },
  );
  it.each(["caller", "abort", "lifecycle", "claim snapshot"] as const)(
    "retains exact construction ownership after delayed preparation: %s",
    async (outcome) => {
      const { createWorkerTurnRunOwner } = await import("./worker-turn-run-owner.js");
      await seedActivePlacement();
      const runId = "run-preparing-worker-owner";
      const claim = await placements.claimTurn({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId,
        claimId: "preparing-claim",
        owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
      });
      const first = await createWorkerTurnRunOwner({
        placements,
        claim,
        turn: turn(runId),
        sessionKey: SESSION_KEY,
      });
      const previous = resolveActiveEmbeddedRunOwner(SESSION_ID);
      const prepared =
        createDeferred<Awaited<ReturnType<typeof placements.prepareTurnClaimAuthority>>>();
      const resume = createDeferred();
      const prepare = placements.prepareTurnClaimAuthority.bind(placements);
      vi.spyOn(placements, "prepareTurnClaimAuthority").mockImplementationOnce(
        async (requested) => {
          const authority = await prepare(requested);
          vi.spyOn(authority, "release");
          prepared.resolve(authority);
          await resume.promise;
          return authority;
        },
      );
      const controller = new AbortController();
      const requested = structuredClone(claim);
      let callerCurrent = true;
      let created: Awaited<ReturnType<typeof createWorkerTurnRunOwner>> | undefined;
      const attempt = createWorkerTurnRunOwner({
        placements,
        claim: requested,
        turn: { ...turn(runId), abortSignal: controller.signal },
        sessionKey: SESSION_KEY,
        assertCurrent: () => {
          if (!callerCurrent) {
            throw new Error("caller authority closed");
          }
        },
      }).then((owner) => {
        created = owner;
        return owner;
      });
      // Attach a rejection observer while the test controls the preparation boundary.
      const settled = attempt.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        const authority = await awaitGateBeforeSettlement(
          prepared.promise,
          attempt,
          "worker owner settled before retaining its claim",
        );
        if (outcome === "caller") {
          callerCurrent = false;
        } else if (outcome === "abort") {
          controller.abort(new Error("cancelled during owner preparation"));
        } else if (outcome === "lifecycle") {
          rotateAgentEventLifecycleGeneration();
        } else {
          requested.claimId = "mutated-after-preparation";
          requested.runId = "mutated-run";
        }
        resume.resolve();
        if (outcome === "claim snapshot") {
          const owner = await attempt;
          expect(owner.claim).toEqual(claim);
          expect(owner.claim).toBe(authority.claim);
          expect(previous?.abort()).toBe(false);
          first.dispose();
          expect(isEmbeddedAgentRunHandleActive(SESSION_ID)).toBe(true);
        } else {
          expect(await settled).toBeInstanceOf(Error);
          expect(authority.release).toHaveBeenCalledOnce();
          expect(authority.isCurrent()).toBe(false);
          expect(previous?.abort()).toBe(outcome !== "lifecycle");
        }
      } finally {
        resume.resolve();
        await settled;
        created?.dispose();
        first.dispose();
      }
    },
  );
});
