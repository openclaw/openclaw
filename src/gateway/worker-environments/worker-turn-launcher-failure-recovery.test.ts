import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { recoverStuckDiagnosticSession } from "../../logging/diagnostic-stuck-session-recovery.runtime.js";
import type { SpawnResult } from "../../process/exec.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "../../worker/transcript-message.js";
import { sessionByKeyReadHandlers } from "../server-methods/sessions-read-by-key.js";
import { requestContext } from "../server-methods/sessions-read-cache.test-support.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { placementTurnOwner } from "./placement-record.js";
import {
  WorkerRunnerCapacityError,
  WorkerRunnerUnavailableError,
  type WorkerTunnelHandle,
} from "./tunnel-contract.js";
import { failHandedOffTurn } from "./worker-turn-failure.js";
import {
  createWorkerTurnTunnel,
  reconcileUnchangedLocalWorkspace,
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  hasLoneSurrogate,
  openSessionManager,
  placements,
  root,
  sessionTarget,
  seedActivePlacement,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
  type WorkerTurnLauncherOptions,
} from "./worker-turn-launcher.test-support.js";

describe("worker turn launcher failure recovery", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it("terminalizes a journal-settled dead worker without waiting for blocked teardown", async () => {
    await seedActivePlacement();
    const launchStarted = createDeferred();
    const finishLaunch = createDeferred();
    const teardownStarted = createDeferred();
    const finishTeardown = createDeferred();
    const environment = {
      ...attachedEnvironment(),
      nodeDeviceId: "node-worker",
      sshEndpoint: null,
    };
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: () => environment,
      acquireTurnCredential: async () => credential(),
      acknowledgeCredentialDelivery: async () => true,
      startTunnel: async () =>
        createWorkerTurnTunnel({
          quiesceWorkspace: vi.fn(),
          syncWorkspace: vi.fn(),
          reconcileWorkspace: vi.fn(),
          stop: vi.fn(),
          launchTurn: async (request) => {
            request.onDispatchReady?.();
            launchStarted.resolve();
            await finishLaunch.promise;
            return {
              stdout: "",
              stderr: "worker admission deadline exceeded",
              code: 1,
              signal: null,
              killed: false,
              termination: "exit",
            };
          },
        }),
      stopTunnel: async () => {
        teardownStarted.resolve();
        await finishTeardown.promise;
      },
      destroy: vi.fn(async () => environment),
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const uninstall = installSessionPlacementAdmissionProvider(provider);
    const operation = createReplyOperation({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      resetTriggered: false,
    });
    operation.setPhase("waiting_for_deferred_maintenance");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const attempt = provider
      .executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-dead-worker",
        },
        turn("run-dead-worker"),
        async () => ({ meta: { durationMs: 1 } }),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const recover = () =>
      recoverStuckDiagnosticSession({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        ageMs: 180_000,
      });
    try {
      await launchStarted.promise;
      await expect(recover()).resolves.toMatchObject({ status: "skipped", action: "observe_only" });
      finishLaunch.resolve();
      await teardownStarted.promise;
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "draining", turnClaim: null });
      await expect(recover()).resolves.toMatchObject({ status: "skipped", action: "observe_only" });
      clock.mockReturnValue(1_030_000);
      await expect(recover()).resolves.toMatchObject({
        status: "failed",
        action: "fail_worker_turn",
        reason: "terminal_worker",
      });
      expect(await attempt).toMatchObject({
        message:
          "Cloud worker process failed before completing the turn: worker admission deadline exceeded",
      });
      expect(placements.get(SESSION_ID)).toMatchObject({
        state: "failed",
        turnClaim: null,
        terminalReason: expect.stringContaining("worker admission deadline exceeded"),
      });
      expect(environments.destroy).not.toHaveBeenCalled();
      finishTeardown.reject(new Error("late tunnel cleanup rejection"));
      await Promise.resolve();
      expect(environments.destroy).not.toHaveBeenCalled();
    } finally {
      finishLaunch.resolve();
      finishTeardown.resolve();
      await attempt;
      clock.mockRestore();
      operation.complete();
      uninstall();
    }
  });

  it("does not destroy a replacement after failed-turn teardown loses its placement", async () => {
    await seedActivePlacement();
    const active = placements.get(SESSION_ID);
    if (active?.state !== "active") {
      throw new Error("expected active placement");
    }
    const turnClaim = await placements.claimTurn({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      claimId: "old-turn-claim",
      runId: "old-turn-run",
      owner: placementTurnOwner(active),
    });
    const teardownStarted = createDeferred();
    const finishTeardown = createDeferred();
    const destroy = vi.fn(async () => attachedEnvironment());
    const cleanup = failHandedOffTurn({
      environments: {
        ...unusedEnvironments(),
        stopTunnel: async () => {
          teardownStarted.resolve();
          await finishTeardown.promise;
        },
        destroy,
      },
      placements,
      placement: active,
      turnClaim,
      error: new Error("original turn failed"),
    });
    try {
      await teardownStarted.promise;
      const reconciling = await placements.startReconcile({
        sessionId: SESSION_ID,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation + 1,
      });
      await placements.fail({
        sessionId: SESSION_ID,
        expectedGeneration: reconciling.generation,
        recoveryError: "recovered elsewhere",
      });
      const replacement = await placements.startDispatch({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
      });
      finishTeardown.resolve();
      await cleanup;
      expect(destroy).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toEqual(replacement);
    } finally {
      finishTeardown.resolve();
      await cleanup;
    }
  });

  it("publishes bounded launch and cancellation diagnostics after held cleanup", async () => {
    await seedActivePlacement();
    const active = placements.get(SESSION_ID);
    if (active?.state !== "active") {
      throw new Error("expected active placement");
    }
    const turnClaim = await placements.claimTurn({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      claimId: "rejected-launch-claim",
      runId: "rejected-launch-run",
      owner: placementTurnOwner(active),
    });
    const secret = "synthetic-worker-recovery-secret";
    const launchDiagnosis = "node worker supervisor worker.launch.v1 failed: invalid descriptor";
    const cancellationDiagnosis =
      "node worker cancellation did not produce a terminal receipt before its deadline";
    const cfg = {
      session: { store: sessionTarget.storePath },
      agents: {
        entries: { main: {} },
        defaults: { model: "unit-test/model", utilityModel: "" },
      },
    };
    const projection = await createSessionRowProjection({
      cfg,
      modelCatalog: [],
      placementFactsReader: placements,
    });
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const respond = vi.fn();
    const describeSession = async () => {
      respond.mockClear();
      await sessionByKeyReadHandlers["sessions.describe"]!({
        req: { type: "req", id: "failed-worker-placement", method: "sessions.describe" },
        params: { key: SESSION_KEY },
        client: null,
        context,
        isWebchatConnect: () => false,
        respond,
      });
    };
    const teardownStarted = createDeferred();
    const finishTeardown = createDeferred();
    const cleanup = failHandedOffTurn({
      environments: {
        ...unusedEnvironments(),
        stopTunnel: async () => {
          teardownStarted.resolve();
          await finishTeardown.promise;
        },
        destroy: async () => attachedEnvironment(),
      },
      placements,
      placement: active,
      turnClaim,
      error: new AggregateError(
        [
          new Error(`${launchDiagnosis}\n token="${secret}"\n${"x".repeat(2_048)}`),
          new Error(cancellationDiagnosis),
        ],
        "node worker launch failed and cancellation could not be confirmed",
      ),
    });

    try {
      await awaitGateBeforeSettlement(
        teardownStarted.promise,
        cleanup,
        "Failed worker did not enter teardown",
      );
      await describeSession();
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({
          placement: expect.objectContaining({ state: "draining" }),
        }),
      });
      finishTeardown.resolve();
      await cleanup;

      const failed = placements.get(SESSION_ID);
      expect(failed).toMatchObject({ state: "failed", turnClaim: null });
      expect(failed?.recoveryError).toContain(launchDiagnosis);
      expect(failed?.recoveryError).toContain(cancellationDiagnosis);
      expect(failed?.recoveryError).not.toContain(secret);
      expect(failed?.recoveryError).not.toContain("\n");
      expect(failed?.recoveryError?.length).toBeLessThanOrEqual(1_024);
      expect(failed?.terminalReason).toBe(failed?.recoveryError);
      await describeSession();
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({
          placement: expect.objectContaining({
            state: "failed",
            recoveryError: failed?.recoveryError,
          }),
        }),
      });
    } finally {
      finishTeardown.resolve();
      await cleanup;
      projection.dispose();
    }
  });

  it.each(["worker-turn", "remote-exec"] as const)(
    "releases an exact %s claim after another lifecycle owner starts draining",
    async (executionMode) => {
      await seedActivePlacement(executionMode);
      const active = placements.get(SESSION_ID);
      if (active?.state !== "active") {
        throw new Error("expected active placement");
      }
      const turnClaim = await placements.claimTurn({
        sessionId: active.sessionId,
        sessionKey: active.sessionKey,
        agentId: active.agentId,
        claimId: `move-${executionMode}-claim`,
        runId: `move-${executionMode}-run`,
        owner: placementTurnOwner(active),
      });
      const draining = await placements.startDrain({
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
      });
      const stopTunnel = vi.fn(async () => {});
      const destroy = vi.fn(async () => attachedEnvironment());

      await failHandedOffTurn({
        environments: { ...unusedEnvironments(), stopTunnel, destroy },
        placements,
        placement: active,
        turnClaim,
        error: new Error("turn interrupted for placement move"),
      });

      expect(placements.get(SESSION_ID)).toMatchObject({
        state: "draining",
        generation: draining.generation,
        environmentId: active.environmentId,
        activeOwnerEpoch: active.activeOwnerEpoch,
        turnClaim: null,
      });
      expect(stopTunnel).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
    },
  );

  it("keeps an active placement when tunnel startup fails before remote handoff", async () => {
    await seedActivePlacement();
    const acknowledgeCredentialDelivery = vi.fn(async () => true);
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => attachedEnvironment());
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery,
      startTunnel: vi.fn(async () => {
        throw Object.assign(new Error("device worker node transport is unavailable"), {
          code: "UNAVAILABLE",
        });
      }),
      stopTunnel,
      destroy,
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-tunnel-unavailable",
        },
        turn("run-tunnel-unavailable"),
        runLocal,
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });

    expect(runLocal).not.toHaveBeenCalled();
    expect(acknowledgeCredentialDelivery).not.toHaveBeenCalled();
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it("fails impossible replay before handoff and keeps the active placement reusable", async () => {
    await seedActivePlacement();
    const manager = await openSessionManager();
    await manager.appendMessageAsync(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call-replay", name: "read", arguments: {} }],
        model: "gpt-test",
        providerReplay: {
          v: 1,
          type: "openai-responses-compaction",
          data: "gAAAAlauncherReplayCiphertext",
          provider: "openai",
          api: "openai-responses",
          model: "gpt-test",
          baseUrlHash: "ozhevd1smnk8s",
        },
        stopReason: "toolUse",
        timestamp: 1,
      }),
    );
    await manager.appendMessageAsync({
      role: "toolResult",
      toolCallId: "call-replay",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      details: { payload: "x".repeat(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) },
      isError: false,
      timestamp: 2,
    });
    const launchTurn = vi.fn(async (): Promise<SpawnResult> => {
      throw new Error("unexpected worker handoff");
    });
    const acknowledgeCredentialDelivery = vi.fn(async () => true);
    const startTunnel = vi.fn(async (): Promise<WorkerTunnelHandle> =>
      createWorkerTurnTunnel({
        quiesceWorkspace: vi.fn(),
        launchTurn,
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
      }),
    );
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => attachedEnvironment());
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery,
      startTunnel,
      stopTunnel,
      destroy,
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-replay-local-fallback",
        },
        turn("run-replay-local-fallback"),
        runLocal,
      ),
    ).rejects.toThrow(WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE);

    expect(startTunnel).toHaveBeenCalledOnce();
    expect(launchTurn).not.toHaveBeenCalled();
    expect(runLocal).not.toHaveBeenCalled();
    expect(acknowledgeCredentialDelivery).not.toHaveBeenCalled();
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it("preserves an unresolved rollback journal when pre-launch recovery conflicts", async () => {
    await seedActivePlacement();
    const active = placements.get(SESSION_ID);
    if (active?.state !== "active") {
      throw new Error("expected active placement for journal recovery");
    }
    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    const basePack = Buffer.from("conflicted journal snapshot");
    await placements.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "e".repeat(32),
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef: `sha256:${"f".repeat(64)}`,
      baseEntries: [
        {
          path: "blocked.txt",
          type: "file",
          mode: 0o644,
          size: 5,
          sha256: createHash("sha256").update("base\n").digest("hex"),
        },
      ],
      appliedEntries: [
        {
          path: "blocked.txt",
          type: "file",
          mode: 0o644,
          size: 7,
          sha256: createHash("sha256").update("worker\n").digest("hex"),
        },
      ],
      baseTree: "d".repeat(40),
      basePackSha256: createHash("sha256").update(basePack).digest("hex"),
      basePack,
    });
    await fs.writeFile(path.join(root, "blocked.txt"), "local\n");
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => attachedEnvironment()),
    };
    const enteredWorkspaceQueue = createDeferred();
    const releaseWorkspaceQueue = createDeferred();
    const workspaceOperations: NonNullable<WorkerTurnLauncherOptions["workspaceOperations"]> = {
      async run(environmentId, operation) {
        expect(environmentId).toBe(ENVIRONMENT_ID);
        enteredWorkspaceQueue.resolve();
        await releaseWorkspaceQueue.promise;
        return await operation();
      },
    };
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      workspaceOperations,
    });

    const attempt = provider.executeTurn(
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId: "run-blocked-journal",
      },
      turn("run-blocked-journal"),
      async () => ({ meta: { durationMs: 1 } }),
    );
    await enteredWorkspaceQueue.promise;
    expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
    releaseWorkspaceQueue.resolve();
    await expect(attempt).rejects.toThrow("workspace recovery could not complete");

    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    expect(await placements.listWorkspaceReconciliationOwners()).toEqual([owner]);
    expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
    expect(environments.destroy).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "offline before transport dispatch",
      error: new WorkerRunnerUnavailableError(),
      dispatched: false,
      expectedMessage: "The device runner is offline",
    },
    {
      name: "capacity rejection after transport dispatch",
      error: new WorkerRunnerCapacityError(),
      dispatched: true,
      expectedMessage: "device worker capacity remained full",
    },
  ])("keeps the placement active after $name", async ({ error, dispatched, expectedMessage }) => {
    await seedActivePlacement();
    const startReconcile = vi.spyOn(placements, "startReconcile");
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => attachedEnvironment());
    const acknowledgeCredentialDelivery = vi.fn(async () => true);
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery,
      startTunnel: vi.fn(async () =>
        createWorkerTurnTunnel({
          launchTurn: vi.fn(async (request) => {
            if (dispatched) {
              request.onDispatchReady?.();
            }
            throw error;
          }),
          reconcileWorkspace: vi.fn(reconcileUnchangedLocalWorkspace),
        }),
      ),
      stopTunnel,
      destroy,
    };
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-failed",
        },
        turn("run-failed"),
        runLocal,
      ),
    ).rejects.toThrow(expectedMessage);
    expect(runLocal).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    expect(acknowledgeCredentialDelivery).toHaveBeenCalledTimes(dispatched ? 1 : 0);
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(startReconcile).not.toHaveBeenCalled();
  });

  it("preserves the admission diagnosis with bounded redacted process failure details", async () => {
    await seedActivePlacement();
    const secret = "$SUPERSECRET123";
    const diagnosis =
      "worker admission deadline exceeded after 3 attempts to gateway.example:18789: connect failed: Opening handshake has timed out; ";
    const redactedPrefix = `${diagnosis}DISCORD_BOT_TOKEN=*** `;
    const padding = "a".repeat(399 - redactedPrefix.length);
    const retained = `${redactedPrefix}${padding}`;
    const emoji = String.fromCodePoint(0x1f600);
    const stderr = `${diagnosis}DISCORD_BOT_TOKEN=${secret} ${padding}${emoji}tail`;
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => attachedEnvironment());
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(async () => true),
      startTunnel: vi.fn(async () =>
        createWorkerTurnTunnel({
          launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
            request.onDispatchReady?.();
            return {
              stdout: "",
              stderr,
              code: 1,
              signal: null,
              killed: false,
              termination: "exit",
            };
          }),
          quiesceWorkspace: vi.fn(async () => {
            throw new Error("unexpected workspace quiescence");
          }),
          reconcileWorkspace: vi.fn(async () => {
            throw new Error("unexpected workspace reconciliation");
          }),
        }),
      ),
      stopTunnel,
      destroy,
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const failurePrefix = "Cloud worker process failed before completing the turn: ";
    let failure: unknown;

    try {
      await provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-process-failed",
        },
        turn("run-process-failed"),
        async () => ({ meta: { durationMs: 1 } }),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toBe(`${failurePrefix}${retained}`);
    expect(message).not.toContain(secret);
    expect(hasLoneSurrogate(message)).toBe(false);
    const placement = placements.get(SESSION_ID);
    expect(placement).toMatchObject({
      state: "failed",
      recoveryError: message,
      terminalReason: message,
      turnClaim: null,
    });
    expect(hasLoneSurrogate(placement?.recoveryError ?? "")).toBe(false);
    expect(stopTunnel).toHaveBeenCalledWith(ENVIRONMENT_ID, OWNER_EPOCH);
    expect(destroy).toHaveBeenCalledWith(ENVIRONMENT_ID);
  });
});
