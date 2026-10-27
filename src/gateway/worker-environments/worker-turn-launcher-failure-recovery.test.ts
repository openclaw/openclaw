import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_TURN_ADMISSION_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-turn-admission.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import * as rootLogger from "../../logger.js";
import type { SpawnResult } from "../../process/exec.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { createReplyOperation, type ReplyOperation } from "../../sessions/session-controller.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "../../worker/transcript-message.js";
import { WorkerNodeLostError } from "../../worker/worker-node-loss.js";
import { sessionByKeyReadHandlers } from "../server-methods/sessions-read-by-key.js";
import { requestContext } from "../server-methods/sessions-read-cache.test-support.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { placementTurnOwner, projectWorkerSessionTurnClaim } from "./placement-record.js";
import { journalOwner } from "./placement-suite.test-support.js";
import {
  WorkerRunnerCapacityError,
  WorkerRunnerUnavailableError,
  WorkerTunnelOwnerDisconnectedError,
  type WorkerTunnelHandle,
} from "./tunnel-contract.js";
import { success } from "./tunnel.test-support.js";
import { failHandedOffTurn } from "./worker-turn-failure.js";
import {
  createLauncher,
  environmentForTunnel,
  executeTurn,
  expectUncalled,
  localResult,
  runIdentity,
} from "./worker-turn-launcher-flow.test-support.js";
import * as fx from "./worker-turn-launcher.test-support.js";
import { workspaceJournal } from "./workspace-manifest-fixtures.test-support.js";

afterAll(closeStateDatabaseForTest);

function heldOperation() {
  const started = createDeferred();
  const finish = createDeferred();
  return {
    started: started.promise,
    finish,
    run: async () => {
      started.resolve();
      await finish.promise;
    },
  };
}

function activePlacement() {
  const active = fx.placements.get(fx.SESSION_ID);
  assert(active?.state === "active", "expected active placement");
  return active;
}

function expectPlacement(expected: object) {
  expect(fx.placements.get(fx.SESSION_ID)).toMatchObject(expected);
}

function workerEnvironment(tunnel: Parameters<typeof fx.createWorkerTurnTunnel>[0]) {
  return environmentForTunnel({
    startTunnel: vi.fn(async () => fx.createWorkerTurnTunnel(tunnel)),
  });
}

function strictEnvironment(overrides: Partial<fx.WorkerTurnEnvironmentService> = {}) {
  return { ...fx.unusedEnvironments(), get: vi.fn(fx.attachedEnvironment), ...overrides };
}

async function failPendingWorkspace(error: Error) {
  const [pending] = await fx.placements.listPendingWorkspaceResultsAsync();
  assert(pending, "Expected pending workspace recovery");
  await fx.placements.failWorkspaceResultAndReleaseTurn(pending, error);
}

async function claimActivePlacement(
  claimId: string,
  runId: string,
  mode: "worker-turn" | "remote-exec" = "worker-turn",
) {
  await fx.seedActivePlacement(mode);
  const active = activePlacement();
  const turnClaim = await fx.placements.claimTurn({
    ...runIdentity(runId),
    claimId,
    owner: placementTurnOwner(active),
  });
  return { active, turnClaim };
}

function heldFailure(
  { active, turnClaim }: Awaited<ReturnType<typeof claimActivePlacement>>,
  error: Error,
) {
  const teardown = heldOperation();
  const destroy = vi.fn(async () => fx.attachedEnvironment());
  const cleanup = failHandedOffTurn({
    environments: { ...fx.unusedEnvironments(), stopTunnel: teardown.run, destroy },
    placements: fx.placements,
    placement: active,
    turnClaim,
    error,
  });
  return { active, teardown, destroy, cleanup };
}

describe("worker turn launcher failure recovery", () => {
  beforeEach(fx.setupWorkerTurnLauncherTest);
  afterEach(() => fx.cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));

  it.each(["supervisor", "runtime"] as const)(
    "keeps the typed node-loss cause through the %s result and failed workspace recovery",
    async (source) => {
      await fx.seedActivePlacement();
      const loss = new WorkerNodeLostError();
      const environment = fx.attachedEnvironment();
      assert(environment.bootstrapReceipt);
      environment.bootstrapReceipt.protocolFeatures.push(WORKER_TURN_ADMISSION_PROTOCOL_FEATURE);
      const recovered = vi.fn(() => failPendingWorkspace(loss));
      const provider = createLauncher({
        reconcileActivePlacement: recovered,
        environments: strictEnvironment({
          get: () => environment,
          acquireTurnCredential: async () => fx.credential(),
          acknowledgeCredentialDelivery: async () => true,
          startTunnel: async () =>
            fx.createWorkerTurnTunnel({
              reconcileWorkspace: fx.reconcileUnchangedLocalWorkspace,
              launchTurn: async (request) => {
                request.onDispatchReady?.();
                await fx.placements.markWorkspaceResultPending(request.turnClaim);
                return {
                  ...success(
                    JSON.stringify({
                      status: "failed",
                      reason: "node-lost",
                      transcriptLeafId: null,
                      transcriptNextSeq: 1,
                    }),
                    "unrelated diagnostic",
                  ),
                  code: source === "supervisor" ? 1 : 0,
                  killed: source === "supervisor",
                  ...(source === "supervisor" ? { nodeLoss: loss } : {}),
                };
              },
            }),
        }),
      });
      const attempt = executeTurn(provider, "node-loss", vi.fn());
      await expect(attempt).rejects.toBeInstanceOf(WorkerNodeLostError);
      expect(recovered).toHaveBeenCalledOnce();
      expectPlacement({ state: "failed", turnClaim: null });
    },
  );

  it("terminalizes a journal-settled dead worker without waiting for blocked teardown", async () => {
    await fx.seedActivePlacement();
    const launch = heldOperation();
    const teardown = heldOperation();
    const environment = {
      ...fx.attachedEnvironment(),
      nodeDeviceId: "node-worker",
      sshEndpoint: null,
    };
    const environments = strictEnvironment({
      get: () => environment,
      acquireTurnCredential: async () => fx.credential(),
      acknowledgeCredentialDelivery: async () => true,
      startTunnel: async () =>
        fx.createWorkerTurnTunnel({
          quiesceWorkspace: vi.fn(),
          syncWorkspace: vi.fn(),
          reconcileWorkspace: vi.fn(),
          stop: vi.fn(),
          launchTurn: async (request) => {
            request.onDispatchReady?.();
            await launch.run();
            return { ...success("", "worker admission deadline exceeded"), code: 1 };
          },
        }),
      stopTunnel: teardown.run,
      destroy: vi.fn(async () => environment),
    });
    const provider = createLauncher({ environments });
    const workerTurn = fx.turn("run-dead-worker");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const unrelated = createReplyOperation({
      sessionId: "unrelated-session",
      sessionKey: "agent:main:unrelated-worker",
      resetTriggered: false,
    });
    let workerOperation: ReplyOperation | undefined;
    const attempt = withSessionTurn(fx.sessionTarget, async (operation, signal) => {
      workerOperation = operation;
      return await provider.executeTurn(
        { ...fx.sessionTarget, runId: workerTurn.runId },
        { ...workerTurn, replyOperation: operation, abortSignal: signal },
        localResult,
      );
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const assertCurrent = vi.fn();
    const recover = () =>
      provider.recoverTerminalTurn?.(
        { sessionId: fx.SESSION_ID, sessionKey: fx.SESSION_KEY, operation: workerOperation },
        assertCurrent,
      );
    try {
      await awaitGateBeforeSettlement(launch.started, attempt, "Worker did not dispatch");
      // A running launch has no journal-terminal cleanup authority.
      await expect(recover()).resolves.toBeUndefined();
      launch.finish.resolve();
      await awaitGateBeforeSettlement(teardown.started, attempt, "Worker did not tear down");
      expectPlacement({ state: "draining", turnClaim: null });
      await expect(recover()).resolves.toBeUndefined();
      expect(assertCurrent).not.toHaveBeenCalled();
      clock.mockReturnValue(1_030_000);
      await expect(
        provider.recoverTerminalTurn?.({
          sessionId: fx.SESSION_ID,
          sessionKey: fx.SESSION_KEY,
          operation: unrelated,
        }),
      ).resolves.toBeUndefined();
      expect(fx.placements.get(fx.SESSION_ID)?.state).toBe("draining");
      await expect(recover()).resolves.toContain("worker admission deadline exceeded");
      expect(assertCurrent).toHaveBeenCalled();
      expect(await attempt).toMatchObject({
        message:
          "Cloud worker process failed before completing the turn: worker admission deadline exceeded",
      });
      expectPlacement({
        state: "failed",
        turnClaim: null,
        terminalReason: expect.stringContaining("worker admission deadline exceeded"),
      });
      expect(environments.destroy).not.toHaveBeenCalled();
      teardown.finish.reject(new Error("late tunnel cleanup rejection"));
      await Promise.resolve();
      expect(environments.destroy).not.toHaveBeenCalled();
    } finally {
      launch.finish.resolve();
      teardown.finish.resolve();
      await attempt;
      unrelated.complete();
      clock.mockRestore();
      workerTurn.preparedRunAdmission.close();
    }
  });

  it("does not destroy a replacement after failed-turn teardown loses its placement", async () => {
    const { active, teardown, destroy, cleanup } = heldFailure(
      await claimActivePlacement("old-turn-claim", "old-turn-run"),
      new Error("original turn failed"),
    );
    try {
      await teardown.started;
      const reconciling = await fx.placements.startReconcile({
        sessionId: fx.SESSION_ID,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation + 1,
      });
      await fx.placements.fail({
        sessionId: fx.SESSION_ID,
        expectedGeneration: reconciling.generation,
        recoveryError: "recovered elsewhere",
      });
      const replacement = await fx.placements.startDispatch({
        sessionId: fx.SESSION_ID,
        sessionKey: fx.SESSION_KEY,
        agentId: "main",
      });
      teardown.finish.resolve();
      await cleanup;
      expect(destroy).not.toHaveBeenCalled();
      expect(fx.placements.get(fx.SESSION_ID)).toEqual(replacement);
    } finally {
      teardown.finish.resolve();
      await cleanup;
    }
  });

  it("publishes bounded launch and cancellation diagnostics after held cleanup", async () => {
    const claim = await claimActivePlacement("rejected-launch-claim", "rejected-launch-run");
    const secret = "synthetic-worker-recovery-secret";
    const launchDiagnosis = "node worker supervisor worker.launch.v1 failed: invalid descriptor";
    const cancellationDiagnosis =
      "node worker cancellation did not produce a terminal receipt before its deadline";
    const cfg = {
      session: { store: fx.sessionTarget.storePath },
      agents: {
        entries: { main: {} },
        defaults: { model: "unit-test/model", utilityModel: "" },
      },
    };
    const projection = await createSessionRowProjection({
      cfg,
      modelCatalog: [],
      placementFactsReader: fx.placements,
    });
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const respond = vi.fn();
    const expectDescribedPlacement = async (placement: object) => {
      respond.mockClear();
      await sessionByKeyReadHandlers["sessions.describe"]!({
        req: { type: "req", id: "failed-worker-placement", method: "sessions.describe" },
        params: { key: fx.SESSION_KEY },
        client: null,
        context,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({ placement: expect.objectContaining(placement) }),
      });
    };
    const { teardown, cleanup } = heldFailure(
      claim,
      new AggregateError(
        [
          new Error(`${launchDiagnosis}\n token="${secret}"\n${"x".repeat(2_048)}`),
          new Error(cancellationDiagnosis),
        ],
        "node worker launch failed and cancellation could not be confirmed",
      ),
    );
    try {
      await awaitGateBeforeSettlement(
        teardown.started,
        cleanup,
        "Failed worker did not enter teardown",
      );
      await expectDescribedPlacement({ state: "draining" });
      teardown.finish.resolve();
      await cleanup;
      const failed = fx.placements.get(fx.SESSION_ID);
      expect(failed).toMatchObject({ state: "failed", turnClaim: null });
      expect(failed?.recoveryError).toContain(launchDiagnosis);
      expect(failed?.recoveryError).toContain(cancellationDiagnosis);
      expect(failed?.recoveryError).not.toContain(secret);
      expect(failed?.recoveryError).not.toContain("\n");
      expect(failed?.recoveryError?.length).toBeLessThanOrEqual(1_024);
      expect(failed?.terminalReason).toBe(failed?.recoveryError);
      await expectDescribedPlacement({ state: "failed", recoveryError: failed?.recoveryError });
    } finally {
      teardown.finish.resolve();
      await cleanup;
      projection.dispose();
    }
  });

  it.each(["worker-turn", "remote-exec"] as const)(
    "releases an exact %s claim after another lifecycle owner starts draining",
    async (executionMode) => {
      const { active, turnClaim } = await claimActivePlacement(
        `move-${executionMode}-claim`,
        `move-${executionMode}-run`,
        executionMode,
      );
      const draining = await fx.placements.startDrain({
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
      });
      const stopTunnel = vi.fn(async () => {});
      const destroy = vi.fn(async () => fx.attachedEnvironment());
      await failHandedOffTurn({
        environments: { ...fx.unusedEnvironments(), stopTunnel, destroy },
        placements: fx.placements,
        placement: active,
        turnClaim,
        error: new Error("turn interrupted for placement move"),
      });
      expectPlacement({
        state: "draining",
        generation: draining.generation,
        environmentId: active.environmentId,
        activeOwnerEpoch: active.activeOwnerEpoch,
        turnClaim: null,
      });
      expectUncalled(stopTunnel, destroy);
    },
  );

  it("fails impossible replay before handoff and keeps the active placement reusable", async () => {
    await fx.seedActivePlacement();
    const manager = await fx.openSessionManager();
    await manager.appendMessageAsync(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call-replay", name: "read", arguments: {} }],
        model: "gpt-5.6-luna",
        providerReplay: {
          v: 1,
          type: "openai-responses-compaction",
          data: "x".repeat(WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES + 1),
          provider: "openai",
          api: "openai-responses",
          model: "gpt-5.6-luna",
          baseUrlHash: "ozhevd1smnk8s",
        },
        stopReason: "toolUse",
        timestamp: 1,
      }),
    );
    await manager.appendMessageAsync(makeTextToolResult("call-replay", "read", "result", false, 2));
    const launchTurn = vi.fn(async (): Promise<SpawnResult> => {
      throw new Error("unexpected worker handoff");
    });
    const environments = workerEnvironment({
      quiesceWorkspace: vi.fn(),
      launchTurn,
      syncWorkspace: vi.fn(),
      reconcileWorkspace: vi.fn(),
    });
    const { startTunnel, stopTunnel, destroy, acknowledgeCredentialDelivery } = environments;
    const persistAbandonedPartial = vi.fn(async () => {});
    const provider = createLauncher({
      environments,
      persistAbandonedPartial,
    });
    const runLocal = vi.fn(localResult);
    await expect(executeTurn(provider, "run-replay-local-fallback", runLocal)).rejects.toThrow(
      WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE,
    );
    expect(startTunnel).toHaveBeenCalledOnce();
    expectUncalled(
      launchTurn,
      persistAbandonedPartial,
      runLocal,
      acknowledgeCredentialDelivery,
      stopTunnel,
      destroy,
    );
    expectPlacement({ state: "active", turnClaim: null });
  });

  it("preserves an unresolved rollback journal when pre-launch recovery conflicts", async () => {
    await fx.seedActivePlacement();
    const active = activePlacement();
    const owner = journalOwner(active);
    const basePack = Buffer.from("conflicted journal snapshot");
    const fileEntry = (text: string) => ({
      path: "blocked.txt",
      type: "file" as const,
      mode: 0o644,
      size: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    });
    await fx.placements.beginWorkspaceReconciliation(
      owner,
      workspaceJournal(active.workspaceBaseManifestRef, `sha256:${"f".repeat(64)}`, {
        temporaryNonce: "e".repeat(32),
        baseEntries: [fileEntry("base\n")],
        appliedEntries: [fileEntry("worker\n")],
        baseTree: "d".repeat(40),
        basePack,
      }),
    );
    await fs.writeFile(path.join(fx.root, "blocked.txt"), "local\n");
    const environments = strictEnvironment();
    const workspaceQueue = heldOperation();
    const workspaceOperations: NonNullable<fx.WorkerTurnLauncherOptions["workspaceOperations"]> = {
      async run(environmentId, operation) {
        expect(environmentId).toBe(fx.ENVIRONMENT_ID);
        await workspaceQueue.run();
        return await operation();
      },
    };
    const provider = createLauncher({
      environments,
      workspaceOperations,
    });
    const attempt = executeTurn(provider, "run-blocked-journal", localResult);
    await workspaceQueue.started;
    expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
    workspaceQueue.finish.resolve();
    await expect(attempt).rejects.toThrow("workspace recovery could not complete");
    expectPlacement({ state: "active", turnClaim: null });
    expect(await fx.placements.listWorkspaceReconciliationOwners()).toEqual([owner]);
    expectUncalled(environments.acquireTurnCredential, environments.destroy);
  });

  it.each([
    [false, new WorkerRunnerUnavailableError(), "The device runner is offline"],
    [true, new WorkerRunnerCapacityError(), "device worker capacity remained full"],
  ] as const)(
    "keeps placement active after a runner rejection (dispatched: %s)",
    async (dispatched, error, expectedMessage) => {
      await fx.seedActivePlacement();
      const startReconcile = vi.spyOn(fx.placements, "startReconcile");
      const environments = workerEnvironment({
        launchTurn: vi.fn(async (request) => {
          if (dispatched) {
            request.onDispatchReady?.();
          }
          throw error;
        }),
        reconcileWorkspace: vi.fn(fx.reconcileUnchangedLocalWorkspace),
      });
      const { stopTunnel, destroy, acknowledgeCredentialDelivery } = environments;
      const provider = createLauncher({ environments });
      const runLocal = vi.fn(localResult);

      await expect(executeTurn(provider, "run-failed", runLocal)).rejects.toThrow(expectedMessage);
      expect(runLocal).not.toHaveBeenCalled();
      expectPlacement({ state: "active", turnClaim: null });
      expect(acknowledgeCredentialDelivery).toHaveBeenCalledTimes(dispatched ? 1 : 0);
      expectUncalled(stopTunnel, destroy, startReconcile);
    },
  );

  it.each([
    { saveRejects: false, pending: false },
    { saveRejects: true, pending: false },
    { saveRejects: false, pending: true },
  ])(
    "preserves process diagnostics and awaits partial persistence (save rejects: $saveRejects, pending: $pending)",
    async ({ saveRejects, pending }) => {
      await fx.seedActivePlacement();
      const secret = "$SUPERSECRET123";
      const diagnosis =
        "worker admission deadline exceeded after 3 attempts to gateway.example:18789: connect failed: Opening handshake has timed out; ";
      const redactedPrefix = `${diagnosis}DISCORD_BOT_TOKEN=*** `;
      const padding = "a".repeat(399 - redactedPrefix.length);
      const retained = `${redactedPrefix}${padding}`;
      const emoji = String.fromCodePoint(0x1f600);
      const stderr = `${diagnosis}DISCORD_BOT_TOKEN=${secret} ${padding}${emoji}tail`;
      const partial = heldOperation();
      const warning = vi.spyOn(rootLogger, "logWarn").mockImplementation(() => {});
      onTestFinished(() => warning.mockRestore());
      const persistAbandonedPartial = vi.fn<
        NonNullable<fx.WorkerTurnLauncherOptions["persistAbandonedPartial"]>
      >(async (claim) => {
        const current = fx.placements.get(fx.SESSION_ID);
        const currentClaim = current && projectWorkerSessionTurnClaim(current);
        assert(currentClaim, "Expected the live interrupted turn claim");
        expect(currentClaim).toMatchObject({ sessionId: claim.sessionId, runId: claim.runId });
        expect(fx.placements.validateTurnClaim(currentClaim)).toBe(true);
        await partial.run();
        if (saveRejects) {
          throw new Error("partial persistence unavailable");
        }
      });
      const environments = workerEnvironment({
        launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
          request.onDispatchReady?.();
          if (pending) {
            await fx.placements.markWorkspaceResultPending(request.turnClaim);
          }
          return { ...success("", stderr), code: 1 };
        }),
        quiesceWorkspace: vi.fn(async () => {
          throw new Error("unexpected workspace quiescence");
        }),
        reconcileWorkspace: vi.fn(async () => {
          throw new Error("unexpected workspace reconciliation");
        }),
      });
      const { stopTunnel, destroy } = environments;
      const provider = createLauncher({
        environments,
        persistAbandonedPartial,
        reconcileActivePlacement: async () => {
          expect(persistAbandonedPartial).toHaveBeenCalledOnce();
          await failPendingWorkspace(new Error("worker stopped"));
        },
      });
      const failurePrefix = "Cloud worker process failed before completing the turn: ";
      const outcome = executeTurn(provider, "run-process-failed").catch((error: unknown) => error);
      try {
        await awaitGateBeforeSettlement(
          partial.started,
          outcome,
          "Worker failure did not preserve its partial reply",
        );
        expect(persistAbandonedPartial).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining(runIdentity("run-process-failed")),
        );
        expectUncalled(stopTunnel, destroy);
        expectPlacement({ state: "active" });
      } finally {
        partial.finish.resolve();
        await outcome;
      }
      const failure = await outcome;
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toBe(`${failurePrefix}${retained}`);
      expect(message).not.toContain(secret);
      expect(fx.hasLoneSurrogate(message)).toBe(false);
      const placement = fx.placements.get(fx.SESSION_ID);
      expect(placement).toMatchObject({ state: "failed", turnClaim: null });
      if (pending) {
        expect(placement).toMatchObject({
          recoveryError: "worker stopped",
          terminalReason: "worker stopped",
        });
        expectUncalled(stopTunnel, destroy);
      } else {
        expect(placement).toMatchObject({ recoveryError: message, terminalReason: message });
        expect(fx.hasLoneSurrogate(placement?.recoveryError ?? "")).toBe(false);
        expect(stopTunnel).toHaveBeenCalledWith(fx.ENVIRONMENT_ID, fx.OWNER_EPOCH);
        expect(destroy).toHaveBeenCalledWith(fx.ENVIRONMENT_ID);
      }
      expect(warning).toHaveBeenCalledTimes(saveRejects ? 1 : 0);
    },
  );

  it("records a remote-exec reconciliation failure after successful execution and releases its local claim", async () => {
    await fx.seedActivePlacement("remote-exec");
    const reconciliationError = new Error("workspace manifest memo exceeds its entry limit");
    const tunnel: WorkerTunnelHandle = {
      environmentId: fx.ENVIRONMENT_ID,
      ownerEpoch: fx.OWNER_EPOCH,
      runWorkspaceCommand: vi.fn(async () => success()),
      quiesceWorkspace: vi.fn(async () => ({
        assertActive: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
      })),
      syncWorkspace: vi.fn(),
      reconcileWorkspace: vi.fn(async () => {
        throw reconciliationError;
      }),
      stop: vi.fn(async () => {}),
    };
    const environments = strictEnvironment({
      startTunnel: vi.fn(async () => tunnel),
    });
    const reconcileActivePlacement = vi.fn(async () => {
      const placement = fx.placements.get(fx.SESSION_ID);
      if (placement?.state !== "failed" || placement.turnClaim !== null) {
        throw new Error("expected terminal placement before teardown recovery");
      }
      expect(await fx.placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    });
    const provider = createLauncher({
      environments,
      reconcileActivePlacement,
    });

    await expect(
      executeTurn(provider, "run-remote-exec-reconcile-failure", async () => ({
        payloads: [{ text: "remote work completed" }],
        meta: {
          durationMs: 1,
          terminalReply: { disposition: "visible", text: "remote work completed" },
        },
      })),
    ).rejects.toMatchObject({
      message: `Cloud worker finished, but its workspace result could not be reconciled: ${reconciliationError.message}`,
    });

    expect(reconcileActivePlacement).toHaveBeenCalledWith(fx.ENVIRONMENT_ID);
    expectPlacement({
      state: "failed",
      turnClaim: null,
      terminalReason: expect.stringContaining(reconciliationError.message),
    });
    expect(await fx.placements.listPendingWorkspaceResultsAsync()).toEqual([]);
  });

  it("preserves a disconnected node-backed placement after failed paired-device execution for a fresh attempt", async () => {
    await fx.seedActivePlacement("remote-exec");
    const original = activePlacement();
    let connected = false;
    const quiesceWorkspace = vi.fn(async () => {
      if (!connected) {
        throw new WorkerTunnelOwnerDisconnectedError(
          "device worker node is not connected with the supervisor dialect",
        );
      }
      return { assertActive: vi.fn(async () => {}), resume: vi.fn(async () => {}) };
    });
    const reconcileWorkspace = vi.fn(fx.reconcileUnchangedLocalWorkspace);
    const launchTurn = vi.fn();
    const tunnel: WorkerTunnelHandle = fx.createWorkerTurnTunnel({
      launchTurn,
      runWorkspaceCommand: vi.fn(async () => success()),
      quiesceWorkspace,
      syncWorkspace: vi.fn(),
      reconcileWorkspace,
    });
    const environment = {
      ...fx.attachedEnvironment(),
      providerId: "device",
      nodeDeviceId: "paired-node-1",
      sshEndpoint: null,
    };
    const environments = strictEnvironment({
      get: vi.fn(() => environment),
      startTunnel: vi.fn(async () => tunnel),
    });
    const reconcileActivePlacement = vi.fn(async () => {});
    const provider = createLauncher({
      environments,
      reconcileActivePlacement,
    });
    const executionFailure = "Codex paired execution device disconnected; start a fresh attempt";

    await expect(
      executeTurn(provider, "run-paired-device-disconnected", async () => {
        throw new Error(executionFailure);
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        `${executionFailure}\n\nWorkspace recovery also failed: device worker node is not connected`,
      ),
      cause: expect.any(Error),
    });

    expectPlacement({
      state: "active",
      generation: original.generation,
      environmentId: original.environmentId,
      activeOwnerEpoch: original.activeOwnerEpoch,
      workspaceBaseManifestRef: original.workspaceBaseManifestRef,
      turnClaim: null,
      terminalReason: null,
    });
    expect(await fx.placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    expectUncalled(reconcileWorkspace, reconcileActivePlacement);

    connected = true;
    await expect(
      executeTurn(provider, "run-paired-device-fresh-attempt", async () => ({
        payloads: [{ text: "fresh node attempt" }],
        meta: { durationMs: 1 },
      })),
    ).resolves.toMatchObject({ payloads: [{ text: "fresh node attempt" }] });

    expect(reconcileWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ baseManifestRef: original.workspaceBaseManifestRef }),
    );
    expect(launchTurn).not.toHaveBeenCalled();
    expectPlacement({ state: "active", turnClaim: null });
  });
});
