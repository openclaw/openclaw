import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerLiveEventParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  isEmbeddedAgentRunHandleActive,
  resolveActiveEmbeddedRunOwner,
  resolveActiveEmbeddedRunOwnerForOperation,
} from "../../agents/embedded-agent-runner/runs.js";
import { resolveSessionPlacementTurnSettlementAssertion } from "../../agents/session-placement-forced-terminal-settlement.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  onAgentEventForRun,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { getDiagnosticSessionActivitySnapshot } from "../../logging/diagnostic-run-activity.js";
import { logSessionStateChange } from "../../logging/diagnostic.js";
import type { ReplyToolAuthorityOverlay } from "../../sessions/session-controller.contracts.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { isReplyRunEvidenceStale } from "../../sessions/session-controller.state.js";
import { steerSessionControllerOperation } from "../../sessions/session-controller.steer.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { createWorkerConnectionIdentity } from "./connection-identity.test-support.js";
import { createWorkerLiveEventReceiver } from "./live-events.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import { getWorkerTurnExecutionIdentityCapability } from "./placement-turn-claim-events.js";
import {
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  createWorkerTurnTunnel,
  placements,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  workerTurnEnvironments,
  workerTurnRequest,
} from "./worker-turn-launcher.test-support.js";
import { captureWorkerTurnLiveEventOwner } from "./worker-turn-run-owner.js";

afterAll(closeStateDatabaseForTest);

function replyOperation(extra: Partial<Parameters<typeof createReplyOperation>[0]> = {}) {
  return createReplyOperation({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    resetTriggered: false,
    ...extra,
  });
}

function claimInput(runId: string) {
  return {
    ...workerTurnRequest(runId),
    owner: { kind: "worker" as const, environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
  };
}

function boundReplyOperation(storeScope = sessionTarget.storePath) {
  return replyOperation({
    target: captureSessionTarget({ storeScope, sessionKey: SESSION_KEY, incarnation: SESSION_ID }),
  });
}

async function claimTurn(runId: string, claimId: string) {
  await seedActivePlacement();
  return placements.claimTurn({ ...claimInput(runId), claimId });
}

function toolEvent(
  phase: "start" | "update",
  toolCallId = "child-provision",
  name = "sessions_spawn",
): WorkerLiveEventParams["event"] {
  return {
    kind: "tool",
    payload:
      phase === "start"
        ? { phase, name, toolCallId, args: {} }
        : { phase, name, toolCallId, partialResult: {} },
  };
}

type OwnerOptions = Parameters<
  typeof import("./worker-turn-run-owner.js").createWorkerTurnRunOwner
>[0];
async function makeOwner(
  claim: WorkerSessionTurnClaim,
  operation: ReturnType<typeof createReplyOperation>,
  options: Partial<Pick<OwnerOptions, "turn" | "assertCurrent">> = {},
) {
  const { createWorkerTurnRunOwner } = await import("./worker-turn-run-owner.js");
  return createWorkerTurnRunOwner({
    placements,
    claim,
    sessionKey: SESSION_KEY,
    isReplyDelivered: () => false,
    ...options,
    turn: options.turn ?? { ...turn(claim.runId), replyOperation: operation },
  });
}

describe("cloud worker run ownership", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));

  it.each([
    { cancellation: "user", firstToolDelayMs: 0, collisionAt: "cancellation" },
    { cancellation: "deadline", firstToolDelayMs: 10 * 60_000, collisionAt: "progress" },
  ] as const)(
    "keeps a bounded remote tool alive until $cancellation cancellation with a shared session ID at $collisionAt",
    async ({ cancellation, firstToolDelayMs, collisionAt }) => {
      let now = Date.UTC(2026, 7, 29);
      const turnStartedAtMs = now;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      await seedActivePlacement();
      const launched = createDeferred();
      const finishLaunch = createDeferred();
      let workerSignal: AbortSignal | undefined;
      const environments = workerTurnEnvironments(
        createWorkerTurnTunnel({
          quiesceWorkspace: vi.fn(),
          syncWorkspace: vi.fn(),
          reconcileWorkspace: vi.fn(),
          stop: vi.fn(),
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
            if (cancellation === "user") {
              // Keep producer custody until its final worker receipt has been acknowledged.
              await finishLaunch.promise;
            }
            throw new Error("worker turn cancelled");
          },
        }),
        {
          acknowledgeCredentialDelivery: async () => true,
          stopTunnel: vi.fn(),
          destroy: vi.fn(async () => attachedEnvironment()),
        },
      );
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      const operation = boundReplyOperation();
      let otherOperation: ReturnType<typeof createReplyOperation> | undefined;
      const collideSessionId = () => {
        otherOperation = boundReplyOperation(`${sessionTarget.storePath}.other`);
      };
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
        .executeTurn(workerTurnRequest(runId), input, vi.fn())
        .catch((error: unknown) => error)
        .finally(() => operation.complete());
      await launched.promise;
      const active = expectDefined(placements.get(SESSION_ID), "expected active placement");
      const turnClaim = expectDefined(
        projectWorkerSessionTurnClaim(active),
        "expected admitted worker turn",
      );
      const turnCapability = expectDefined(
        getWorkerTurnExecutionIdentityCapability(placements, turnClaim),
        "expected worker turn capability",
      );
      const identity: WorkerConnectionIdentity = createWorkerConnectionIdentity(turnClaim, {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        sessionId: SESSION_ID,
        runId,
        credentialHash: "worker-test-credential-hash",
        protocolFeatures: ["worker-live-event-v1"],
        credentialExpiresAtMs: Date.now() + input.timeoutMs,
      });
      const receiver = createWorkerLiveEventReceiver();
      const receive = (event: WorkerLiveEventParams["event"], seq: number, sender = identity) =>
        receiver.apply({
          readAckedSeq: () => 0,
          source: turnCapability,
          identity: sender,
          request: { runEpoch: OWNER_EPOCH, lastAckedSeq: seq - 1, seq, runId, event },
        });
      const acknowledge = async (event: WorkerLiveEventParams["event"], seq: number) => {
        expect(await receive(event, seq)).toEqual({ ok: true, result: { ackedSeq: seq } });
      };
      now = turnStartedAtMs + firstToolDelayMs;
      const previousDiagnostics = areDiagnosticsEnabledForProcess();
      setDiagnosticsEnabledForProcess(true);
      logSessionStateChange({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        state: "processing",
      });
      try {
        if (collisionAt === "progress") {
          collideSessionId();
        }
        await acknowledge(toolEvent("start"), 1);
        now = turnStartedAtMs + 20 * 60_000 + 1;

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
          steerSessionControllerOperation({ operation, text: "follow up", options: {} }),
        ).resolves.toMatchObject({
          status: "rejected",
          reason: "injection_unavailable",
        });
        if (cancellation === "user") {
          collideSessionId();
          expect(resolveActiveEmbeddedRunOwnerForOperation(operation)?.abort()).toBe(true);
          expect(placements.validateTurnClaim(turnClaim)).toBe(true);
          await expect(turnCapability.run(async () => "late effect")).rejects.toThrow();
          const finishing = {
            kind: "lifecycle" as const,
            payload: { phase: "finishing" as const, aborted: true, endedAt: now },
          };
          const lateEvent = vi.fn();
          const unsubscribe = onAgentEventForRun(runId, lateEvent);
          try {
            expect(
              await receive(finishing, 2, {
                ...identity,
                turnClaim: { ...turnClaim, claimId: "foreign-claim" },
              }),
            ).toEqual({ ok: false, details: { reason: "invalid-event" } });
            await acknowledge(finishing, 2);
            expect(lateEvent).not.toHaveBeenCalled();
          } finally {
            unsubscribe();
          }
        } else {
          await acknowledge(toolEvent("update"), 2);
          now = turnStartedAtMs + input.timeoutMs - 1;
          expect(isReplyRunEvidenceStale(operation)).toBe(false);
          now += 1;
          expect(isReplyRunEvidenceStale(operation)).toBe(true);
          await operation.watchdog.tick();
          expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
        }
        expect(workerSignal?.aborted).toBe(true);
        expect(otherOperation?.abortSignal.aborted).toBe(false);
        finishLaunch.resolve();
        await attempt;
        operation.complete();
        await operation.ownerSettlement;
        expect(isEmbeddedAgentRunHandleActive(SESSION_ID)).toBe(false);
        expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
        expect(
          getDiagnosticSessionActivitySnapshot({ sessionId: SESSION_ID }).activeWorkKind,
        ).toBeUndefined();
        expect(environments.destroy).not.toHaveBeenCalled();
      } finally {
        setDiagnosticsEnabledForProcess(previousDiagnostics);
        finishLaunch.resolve();
        operation.abortByUser();
        await attempt;
        operation.complete();
        otherOperation?.complete();
        receiver.clear();
        clock.mockRestore();
      }
    },
  );

  it("uses accepted approval expiry and live custody without trusting worker events", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const runId = "worker-approval-wait";
    const claim = await claimTurn(runId, "approval-wait-claim");
    const operation = replyOperation();
    operation.setPhase("running");
    const worker = await makeOwner(claim, operation, {
      turn: { ...turn(runId), timeoutMs: 30 * 60_000, replyOperation: operation },
    });
    const owner = captureWorkerTurnLiveEventOwner({ sessionId: SESSION_ID, turnClaim: claim });
    expect(
      captureWorkerTurnLiveEventOwner({ sessionId: "different-session", turnClaim: claim }),
    ).toBeUndefined();
    let pending = true;
    const expiresAtMs = now + 12 * 60_000;
    const wait = owner?.beginApprovalWait(expiresAtMs, () => pending);
    try {
      expect(wait).toBeDefined();
      clock.mockReturnValue(now + 7 * 60_000);
      expect(operation.watchdog.decide()).toMatchObject({
        action: "observe",
        reason: "approval",
        deadlineAtMs: expiresAtMs,
      });
      pending = false;
      expect(operation.watchdog.decide()).toMatchObject({
        action: "stop",
        reason: "semantic_stall",
      });
      pending = true;
      clock.mockReturnValue(expiresAtMs);
      expect(operation.watchdog.decide()).toMatchObject({
        action: "stop",
        reason: "semantic_stall",
      });
      wait?.close();
      expect(operation.watchdog.snapshot().waits).toEqual([]);
      await placements.releaseTurn(claim);
      owner?.beginApprovalWait(expiresAtMs + 60_000, () => true);
      expect(operation.watchdog.snapshot().waits).toEqual([]);
    } finally {
      wait?.close();
      worker.dispose();
      operation.complete();
      clock.mockRestore();
    }
  });

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
      const runId = "reused-worker-run";
      const input = claimInput(runId);
      const firstClaim = await claimTurn(runId, "first-claim");
      const operation = replyOperation({ agentId: "main" });
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
              acceptsRequesterOrigin: () => false,
              project,
              projectAsync: async (overlay) => project(overlay),
              assertRegistrationActive: () => {},
              assertActive: () => {},
            };
          },
        },
        () => makeOwner(firstClaim, operation),
      );
      expect(assertSettlementCurrent).toBeTypeOf("function");
      assertSettlementCurrent?.();
      const identity = { sessionId: SESSION_ID, turnClaim: firstClaim };
      const eventOwner = captureWorkerTurnLiveEventOwner(identity);
      expect(eventOwner?.record).toBeTypeOf("function");
      if (cancelled) {
        expect(resolveActiveEmbeddedRunOwner(SESSION_ID)?.abort()).toBe(true);
        expect(eventOwner?.isCancelled()).toBe(true);
      }
      const event = toolEvent("start", "stale-tool");
      let replacement: Awaited<ReturnType<typeof makeOwner>> | undefined;
      let replacementOperation: ReturnType<typeof createReplyOperation> | undefined;

      try {
        if (closure === "shutdown") {
          rotateAgentEventLifecycleGeneration();
          expect(resolveActiveEmbeddedRunOwner(SESSION_ID)).toBeUndefined();
          expect(first.signal.aborted).toBe(true);
        } else {
          const sameClaim = closure === "same-claim replacement";
          if (sameClaim) {
            first.dispose();
          }
          await placements.releaseTurn(firstClaim);
          if (closure === "same-claim readmission") {
            await placements.claimTurn({ ...input, claimId: firstClaim.claimId });
          } else if (sameClaim || closure === "replacement") {
            if (!sameClaim) {
              first.dispose();
            }
            operation.complete();
            await operation.ownerSettlement;
            const nextClaim = await placements.claimTurn({
              ...input,
              claimId: sameClaim ? firstClaim.claimId : "replacement-claim",
            });
            replacementOperation = replyOperation({ agentId: "main" });
            replacement = await makeOwner(nextClaim, replacementOperation);
            if (sameClaim) {
              expect(captureWorkerTurnLiveEventOwner(identity)).not.toBe(eventOwner);
            } else {
              expect(captureWorkerTurnLiveEventOwner(identity)).toBeUndefined();
              captureWorkerTurnLiveEventOwner({ ...identity, turnClaim: nextClaim })?.record(
                toolEvent("start", "current-tool", "exec"),
              );
            }
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
        replacementOperation?.complete();
        operation.complete();
      }
    },
  );
  it.each(["caller", "abort", "lifecycle", "claim snapshot"] as const)(
    "retains exact construction ownership after delayed preparation: %s",
    async (outcome) => {
      const runId = "run-preparing-worker-owner";
      const claim = await claimTurn(runId, "preparing-claim");
      const operation = replyOperation({ agentId: "main" });
      const first = await makeOwner(claim, operation);
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
      let created: Awaited<ReturnType<typeof makeOwner>> | undefined;
      const attempt = makeOwner(requested, operation, {
        turn: { ...turn(runId), abortSignal: controller.signal, replyOperation: operation },
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
          await attempt;
          expect(authority.claim).toEqual(claim);
          expect(
            captureWorkerTurnLiveEventOwner({ sessionId: SESSION_ID, turnClaim: claim }),
          ).toBeDefined();
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
        operation.complete();
      }
    },
  );
});
