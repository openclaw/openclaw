import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { waitForEmbeddedAgentRunEnd } from "../../agents/embedded-agent-runner/runs.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SpawnResult } from "../../process/exec.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { result as processResult } from "./bootstrap.test-support.js";
import { placementTurnOwner } from "./placement-record.js";
import { completeWorkerWorkspaceTeardown } from "./placement-teardown.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import { createWorkerGatewayTools } from "./worker-session-tool-executor.js";
import { waitForPendingWorkerResult } from "./worker-turn-admission.js";
import {
  completeTurn,
  createLauncher,
  environmentForTunnel,
  launchDescriptor,
  executeTurn,
  localResult,
  runIdentity,
} from "./worker-turn-launcher-flow.test-support.js";
import {
  createWorkerTurnTunnel,
  reconcileUnchangedLocalWorkspace,
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  database,
  dispatchInitialWorkerPlacement,
  createWorkerSessionTurnPlacementProvider,
  credential,
  openSessionManager,
  placements,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  withWorkerCompactionAdoption,
} from "./worker-turn-launcher.test-support.js";

afterAll(closeStateDatabaseForTest);

async function claimActiveTurn(
  prefix: string,
  mode: "worker-turn" | "remote-exec" = "worker-turn",
) {
  await seedActivePlacement(mode);
  const active = placements.get(SESSION_ID);
  if (active?.state !== "active") {
    throw new Error("expected active placement");
  }
  const claim = await placements.claimTurn({
    ...runIdentity(`${prefix}-run`),
    claimId: `${prefix}-claim`,
    owner: placementTurnOwner(active),
  });
  return { active, claim };
}

describe("worker turn launcher claim admission", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));

  it.each(["worker-turn", "remote-exec"] as const)(
    "rejects compaction successors throughout the %s placement lifecycle without changing ownership",
    async (executionMode) => {
      const provider = createLauncher();
      const successorGate = vi.spyOn(provider, "assertCompactionSuccessorAllowed");
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      try {
        await withWorkerCompactionAdoption("run-placement-compaction", async (adopt) => {
          const successorId = "session-unsupported-successor";
          const assertRejected = async () => {
            const before = placements.get(SESSION_ID);
            const entryBefore = loadSessionEntry(sessionTarget);
            await expect(adopt(successorId), before?.state).rejects.toThrow(
              /worker placement.*same session ID/u,
            );
            expect(placements.get(SESSION_ID)).toEqual(before);
            expect(loadSessionEntry(sessionTarget)).toEqual(entryBefore);
            expect(await placements.getAsync(successorId)).toBeUndefined();
          };
          const localClaim = await placements.claimTurn({
            ...sessionTarget,
            claimId: "local-before-dispatch",
            runId: "run-placement-compaction",
            owner: { kind: "local" },
          });
          const placement = await dispatchInitialWorkerPlacement({
            database,
            placements,
            identity: { ...sessionTarget, executionMode },
            workspace: "/worker/workspace",
            onTransition: async (current) => {
              if (current.state === "requested") {
                await expect(adopt(SESSION_ID)).resolves.toBeUndefined();
                expect(successorGate).not.toHaveBeenCalled();
              }
              await assertRejected();
              if (current.state === "requested") {
                expect(placements.validateTurnClaim(localClaim)).toBe(true);
                await placements.releaseTurn(localClaim);
              }
            },
          });
          const workerClaim = await placements.claimTurn({
            ...sessionTarget,
            claimId: "active-worker-compaction",
            runId: "run-placement-compaction",
            owner: placementTurnOwner(placement),
          });
          await assertRejected();
          const draining = await placements.startDrain({
            sessionId: SESSION_ID,
            environmentId: ENVIRONMENT_ID,
            ownerEpoch: OWNER_EPOCH,
            expectedGeneration: placement.generation,
          });
          await assertRejected();
          expect(placements.validateTurnClaim(workerClaim)).toBe(true);
          await placements.releaseTurn(workerClaim);
          const reconciling = await placements.startReconcile({
            sessionId: SESSION_ID,
            environmentId: ENVIRONMENT_ID,
            ownerEpoch: OWNER_EPOCH,
            expectedGeneration: draining.generation,
          });
          await assertRejected();
          await placements.transition({
            sessionId: SESSION_ID,
            from: "reconciling",
            to: "reclaimed",
            expectedGeneration: reconciling.generation,
          });
          await assertRejected();
          await placements.startDispatch({ ...sessionTarget, executionMode });
          await placements.fail({
            sessionId: SESSION_ID,
            recoveryError: "fixture dispatch failed",
          });
          await assertRejected();
        });
      } finally {
        uninstall();
      }
    },
  );

  it.each(["worker-turn", "remote-exec"] as const)(
    "holds a %s replacement across pending-result admission and reconciliation",
    async (mode) => {
      const { claim: priorClaim } = await claimActiveTurn("prior-result", mode);
      const projectionReads = vi.spyOn(placements, "readProjection");
      let readsBeforeClaim = 0;
      if (mode === "remote-exec") {
        const claimTurn = placements.claimTurn.bind(placements);
        vi.spyOn(placements, "claimTurn").mockImplementationOnce(async (...args) => {
          readsBeforeClaim = projectionReads.mock.calls.length;
          try {
            return await claimTurn(...args);
          } catch (error) {
            await placements.markWorkspaceResultPending(priorClaim);
            throw error;
          }
        });
      } else {
        await placements.markWorkspaceResultPending(priorClaim);
      }
      const waitForRelease = vi.spyOn(placements, "waitForTurnClaimRelease");
      const provider = createLauncher();

      if (mode === "worker-turn") {
        await expect(executeTurn(provider, priorClaim.runId)).rejects.toThrow(
          "already has an active turn claim",
        );
        expect(waitForRelease).not.toHaveBeenCalled();
      }

      const replacement = executeTurn(provider, "next-run");
      void replacement.catch(() => undefined);
      await vi.waitFor(() => expect(waitForRelease).toHaveBeenCalledOnce());
      expect(waitForRelease).toHaveBeenCalledWith(SESSION_ID, {});
      expect(placements.get(SESSION_ID)?.turnClaim?.runId).toBe(priorClaim.runId);

      await placements.updateWorkspaceBaseManifest({
        claim: priorClaim,
        manifestRef: MANIFEST_REF,
      });
      await placements.acceptWorkspaceResult(priorClaim);
      await placements.completeWorkspaceResultAndReleaseTurn(priorClaim);
      await expect(replacement).rejects.toThrow(
        `Active ${mode === "worker-turn" ? "worker" : "remote-exec"} placement does not match its attached environment`,
      );
      // Both preparation facts must come from one worker request, even when claim admission loses a race.
      if (mode === "remote-exec") {
        expect(readsBeforeClaim).toBe(1);
      }
    },
  );

  it("returns a recovery outcome for restart-cleared claim retry", async () => {
    const runId = "restart-result-run";
    await seedActivePlacement("remote-exec");
    const priorClaim = await placements.claimTurn({
      ...sessionTarget,
      claimId: "restart-result-claim",
      runId: "restart-result-run",
      owner: { kind: "local", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
    });
    await placements.markWorkspaceResultPending(priorClaim);
    await placements.recordStagedWorkspaceResult(
      priorClaim,
      "refs/openclaw/worker-results/missing",
    );
    await placements.clearLocalTurnClaimsAfterRestartAsync();
    const pending = await placements.listPendingWorkspaceResultsAsync();
    expect(pending).toMatchObject([
      { stagedResultRef: "refs/openclaw/worker-results/missing", workspaceAcceptedAtMs: null },
    ]);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();

    // Prove the wait boundary first: a resolved claim wait must not trigger a retry loop.
    await expect(waitForPendingWorkerResult({ placements, sessionId: SESSION_ID })).rejects.toThrow(
      "Workspace recovery is still pending",
    );
    const runLocal = vi.fn(localResult);
    const provider = createLauncher();
    await expect(
      provider.executeTurn({ ...sessionTarget, runId }, turn(runId), runLocal),
    ).rejects.toThrow("Wait for workspace recovery to finish before retrying");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(runLocal).not.toHaveBeenCalled();
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual(pending);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });

  it("redispatches the admitted replacement after pending-result recovery reclaims it", async () => {
    const { active, claim: priorClaim } = await claimActiveTurn("reclaimed-result");
    await placements.markWorkspaceResultPending(priorClaim);
    await placements.startWorkspaceResultDrain(priorClaim);
    vi.spyOn(placements, "waitForTurnClaimRelease").mockImplementationOnce(async () => {
      await placements.updateWorkspaceBaseManifest({
        claim: priorClaim,
        manifestRef: MANIFEST_REF,
      });
      await placements.acceptWorkspaceResult(priorClaim);
      await completeWorkerWorkspaceTeardown({
        placements,
        turnClaim: priorClaim,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      });
    });
    const redispatchPlacement = vi.fn(async () => {
      throw new Error("redispatch reached");
    });
    const provider = createLauncher({ redispatchPlacement });

    await expect(executeTurn(provider, "next-after-reclaim")).rejects.toThrow("redispatch reached");
    expect(redispatchPlacement).toHaveBeenCalledOnce();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "reclaimed", turnClaim: null });
  });

  it("waits for an exact cancelled worker turn and preserves its placement for the next run", async () => {
    await seedActivePlacement();
    const cancelled = new AbortController();
    const cancellationStarted = createDeferred();
    const finishCancellation = createDeferred();
    let launchCount = 0;
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => attachedEnvironment());
    const launchTurn = vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
      request.onDispatchReady?.();
      launchCount += 1;
      if (launchCount === 1) {
        cancellationStarted.resolve();
        await finishCancellation.promise;
        return processResult({ code: 1, killed: true });
      }
      return completeTurn(request, "Recovered after cancellation", 41);
    });
    const environments = environmentForTunnel({
      acquireTurnCredential: vi.fn(async () => credential(String(launchCount + 1).repeat(43))),
      startTunnel: vi.fn(async () =>
        createWorkerTurnTunnel({
          launchTurn,
          reconcileWorkspace: vi.fn(reconcileUnchangedLocalWorkspace),
        }),
      ),
      stopTunnel,
      destroy,
    });
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const firstRunId = "run-cancelled-worker";
    const first = provider.executeTurn(
      runIdentity(firstRunId),
      { ...turn(firstRunId), abortSignal: cancelled.signal },
      localResult,
    );
    void first.catch(() => undefined);
    let replacement: Promise<unknown> | undefined;

    try {
      await cancellationStarted.promise;
      await expect(executeTurn(provider, firstRunId)).rejects.toThrow(
        "already has an active turn claim",
      );
      await expect(executeTurn(provider, "run-live-collision")).rejects.toThrow(
        "already has an active turn claim",
      );
      const waitForRelease = vi.spyOn(placements, "waitForTurnClaimRelease");
      cancelled.abort(new Error("operator stopped the previous turn"));
      replacement = executeTurn(provider, "run-after-cancellation");
      void replacement.catch(() => undefined);

      await vi.waitFor(() => expect(waitForRelease).toHaveBeenCalledOnce());
      expect(placements.get(SESSION_ID)?.turnClaim?.runId).toBe(firstRunId);
      expect(launchTurn).toHaveBeenCalledOnce();

      finishCancellation.resolve();
      await expect(first).rejects.toThrow("Cloud worker process failed before completing the turn");
      await expect(replacement).resolves.toMatchObject({
        payloads: [{ text: "Recovered after cancellation" }],
      });
      await waitForEmbeddedAgentRunEnd(SESSION_ID, null);
      expect(stopTunnel).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    } finally {
      finishCancellation.resolve();
      await Promise.allSettled([first, replacement].filter((operation) => operation !== undefined));
    }
  });

  it.each([
    { label: "without node portal support", portalAvailable: false },
    { label: "with negotiated node portal support", portalAvailable: true },
  ])("launches one worker loop $label", async ({ portalAvailable }) => {
    await seedActivePlacement();
    const unexpectedToolCall = () => {
      throw new Error("Unexpected Gateway tool invocation while preparing the turn");
    };
    const commandStarted = createDeferred();
    const commandFinished = createDeferred<SpawnResult>();
    const launchTurn = vi.fn<WorkerTurnTunnelHandle["launchTurn"]>((request) => {
      request.onDispatchReady?.();
      commandStarted.resolve();
      return commandFinished.promise;
    });
    const environments = environmentForTunnel({
      get: vi.fn(() => ({
        ...attachedEnvironment(),
        nodeDeviceId: "cloud-node-1",
        sshEndpoint: null,
      })),
      supportsNodePortal: vi.fn(async () => portalAvailable),
      createGatewayTools: async (params) =>
        createWorkerGatewayTools({
          ...params,
          placements,
          environments,
          resolveGatewayContext: unexpectedToolCall,
          dispatchChild: unexpectedToolCall,
          portals: {
            getService: unexpectedToolCall,
            carrier: { open: unexpectedToolCall },
            onChanged: unexpectedToolCall,
          },
        }),
      startTunnel: vi.fn(async () =>
        createWorkerTurnTunnel({
          launchTurn,
          reconcileWorkspace: vi.fn(reconcileUnchangedLocalWorkspace),
        }),
      ),
    });
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const claim = runIdentity("run-overlap");
    const uninstall = installSessionPlacementAdmissionProvider(provider);
    try {
      await withWorkerCompactionAdoption("run-overlap", async (adopt, workerTurn) => {
        const controller = new AbortController();
        const runLocal = vi.fn(localResult);
        const first = provider.executeTurn(
          claim,
          { ...workerTurn, abortSignal: controller.signal },
          runLocal,
        );
        void first.catch(() => undefined);
        try {
          await Promise.race([commandStarted.promise, first]);
          const launchRequest = launchTurn.mock.calls[0]?.[0];
          if (!launchRequest) {
            throw new Error("expected worker launch request");
          }
          const placementBefore = placements.get(SESSION_ID);
          const entryBefore = loadSessionEntry(sessionTarget);
          await expect(adopt("session-worker-successor")).rejects.toThrow(
            /worker placement.*same session ID/u,
          );
          expect(placements.get(SESSION_ID)).toEqual(placementBefore);
          expect(loadSessionEntry(sessionTarget)).toEqual(entryBefore);
          expect(placements.validateTurnClaim(launchRequest.turnClaim)).toBe(true);
          expect(launchRequest.signal?.aborted).toBe(false);
          expect(runLocal).not.toHaveBeenCalled();
          await expect(provider.executeTurn(claim, turn("run-overlap"), runLocal)).rejects.toThrow(
            "already has an active turn claim",
          );
          expect(launchTurn).toHaveBeenCalledOnce();

          const completed = await openSessionManager();
          const leafId = await completed.appendMessageAsync(
            makeAgentAssistantMessage({
              content: [{ type: "text", text: "Only worker reply" }],
              timestamp: 31,
            }),
          );
          expect(launchRequest.plan.assignment).toMatchObject({
            workspaceDir: "/worker/workspace",
            permissionMode: "workspace",
            workerContainmentRoot: "/worker/workspace",
          });
          expect(placements.isWorkerTurnToolAuthorized(launchRequest.turnClaim, "portal")).toBe(
            portalAvailable,
          );
          expect(environments.supportsNodePortal).toHaveBeenCalledWith(ENVIRONMENT_ID, OWNER_EPOCH);
          await createWorkerSessionPlacementGate(placements).updateAckCursors({
            claim: launchRequest.turnClaim,
            transcriptSeq: 2,
            liveSeq: 1,
          });
          const active = placements.get(SESSION_ID);
          if (active?.state !== "active") {
            throw new Error("expected active placement before drain race");
          }
          await expect(
            placements.startDrain({
              sessionId: active.sessionId,
              environmentId: active.environmentId,
              ownerEpoch: active.activeOwnerEpoch,
              expectedGeneration: active.generation,
            }),
          ).rejects.toThrow("pending cloud workspace result");
          commandFinished.resolve(
            processResult({
              stdout: JSON.stringify({
                status: "completed",
                transcriptLeafId: leafId,
                transcriptNextSeq: (placements.get(SESSION_ID)?.lastTranscriptAckCursor ?? 0) + 1,
              }),
            }),
          );
          await expect(first).resolves.toMatchObject({ payloads: [{ text: "Only worker reply" }] });
          await waitForEmbeddedAgentRunEnd(SESSION_ID, null);
          const completedPlacement = placements.get(SESSION_ID);
          if (completedPlacement?.state !== "active") {
            throw new Error("expected active placement after worker completion");
          }
          await placements.startDrain({
            sessionId: completedPlacement.sessionId,
            environmentId: completedPlacement.environmentId,
            ownerEpoch: completedPlacement.activeOwnerEpoch,
            expectedGeneration: completedPlacement.generation,
          });
          expect(placements.get(SESSION_ID)).toMatchObject({ state: "draining", turnClaim: null });
        } finally {
          controller.abort();
          commandFinished.resolve(
            processResult({
              stderr: "fixture closed",
              code: 1,
            }),
          );
          await Promise.allSettled([first]);
        }
      });
    } finally {
      uninstall();
    }
  });

  it("keeps an active placement after an acknowledged turn failure and admits the next turn", async () => {
    await seedActivePlacement();
    const turnIds: string[] = [];
    let launchCount = 0;
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => attachedEnvironment());
    const environments = environmentForTunnel({
      acquireTurnCredential: vi.fn(async () => credential(String(launchCount + 1).repeat(43))),
      startTunnel: vi.fn(async () =>
        createWorkerTurnTunnel({
          launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
            request.onDispatchReady?.();
            launchCount += 1;
            const descriptor = launchDescriptor(request.plan);
            turnIds.push(descriptor.assignment.turnId);
            if (launchCount === 1) {
              const completed = await openSessionManager();
              const leafId = await completed.appendMessageAsync(
                makeAgentAssistantMessage({
                  content: [{ type: "text", text: "Remote model failed" }],
                  stopReason: "error",
                  errorMessage: "Cloud worker turn failed",
                  timestamp: 31,
                }),
              );
              await createWorkerSessionPlacementGate(placements).updateAckCursors({
                claim: request.turnClaim,
                transcriptSeq: 2,
                liveSeq: 1,
              });
              return processResult({
                stdout: JSON.stringify({
                  status: "failed",
                  reason: "turn-failed",
                  transcriptLeafId: leafId,
                  transcriptNextSeq: (placements.get(SESSION_ID)?.lastTranscriptAckCursor ?? 0) + 1,
                }),
              });
            }
            return completeTurn(request, "Recovered worker reply", 41);
          }),
          reconcileWorkspace: vi.fn(reconcileUnchangedLocalWorkspace),
        }),
      ),
      stopTunnel,
      destroy,
    });
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

    await expect(executeTurn(provider, "run-model-failed")).rejects.toThrow(
      "Cloud worker turn failed",
    );
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);

    await expect(executeTurn(provider, "run-model-recovered")).resolves.toMatchObject({
      payloads: [{ text: "Recovered worker reply" }],
    });
    await waitForEmbeddedAgentRunEnd(SESSION_ID, null);
    expect(turnIds).toHaveLength(2);
    expect(turnIds[0]).not.toBe(turnIds[1]);
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });
});
